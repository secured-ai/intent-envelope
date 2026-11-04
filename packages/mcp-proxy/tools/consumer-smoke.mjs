#!/usr/bin/env node
/**
 * Pack the package, install it as a customer would, and refuse a call with the binary.
 *
 * This package ships a `bin`, which is exactly the kind of thing that works in the source
 * tree and fails on install: the shebang, the exports map, the files list, and whether
 * dist/bin.js exists at all after prepack. The suite cannot see any of that, because it
 * runs src/bin.ts straight from this directory.
 *
 * The precedent is intent-envelope 0.0.1, which reached PyPI carrying only the validator
 * while the README documented an enforcement point. Every test passed.
 *
 * Run: node tools/consumer-smoke.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = join(PKG, 'test/fixtures/fake-upstream.mjs');
const ENVELOPE = join(PKG, 'test/fixtures/ap-agent.json');

function exec(cmd, args, cwd) {
  const done = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return done;
}

/**
 * npm is a .cmd shim on Windows and Node refuses to spawn .cmd without a shell, so run
 * npm's own entry point through this Node binary instead. Identical on every platform.
 */
function npm(args, cwd) {
  if (process.env.npm_execpath) return exec(process.execPath, [process.env.npm_execpath, ...args], cwd);
  if (process.platform === 'win32') {
    return execFileSync('npm.cmd', args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)), {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: true,
    });
  }
  return exec('npm', args, cwd);
}

const scratch = mkdtempSync(join(tmpdir(), 'intent-envelope-mcp-consumer-'));

async function drive(binary) {
  // Talk to the installed binary exactly as an MCP client would.
  const child = spawn(process.execPath, [binary, '--envelope', ENVELOPE, '--', process.execPath, UPSTREAM], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) {
        const message = JSON.parse(line);
        const r = waiting.get(String(message.id));
        if (r) {
          waiting.delete(String(message.id));
          r(message);
        }
      }
      i = buffer.indexOf('\n');
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    stderr += c;
  });

  const call = (id, name, args) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no reply to ${name}`)), 10000);
      waiting.set(String(id), (m) => {
        clearTimeout(timer);
        done(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    });

  const allowed = await call(1, 'read_invoice', { invoice_id: '1', period: 'current_month' });
  if (allowed.error) throw new Error(`the installed binary refused an allowed call: ${allowed.error.message}`);

  const refused = await call(2, 'issue_payment', { amount_gbp: 24900 });
  if (!refused.error) throw new Error('the installed binary allowed a denied call');
  if (refused.error.code !== -32000) throw new Error(`wrong error code ${refused.error.code}`);
  if (refused.error.data?.intent_envelope?.rule !== 'tools.deny') throw new Error('wrong rule in the refusal');

  child.stdin.end();
  await new Promise((done) => child.on('exit', done));
  if (!/1 allowed, 1 refused/.test(stderr)) throw new Error(`the summary is missing from stderr:\n${stderr}`);
}

let failed = false;
try {
  // prepack builds dist, so this is the tarball npm publish would upload.
  const tarball = npm(['pack', '--silent', '--pack-destination', scratch], PKG).trim();
  console.log(`packed ${tarball}`);

  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  npm(['install', '--silent', '--no-audit', '--no-fund', join(scratch, tarball)], scratch);

  // The bin as npm installed it, not the source.
  const binary = join(scratch, 'node_modules', 'intent-envelope-mcp', 'dist', 'bin.js');
  await drive(binary);
  console.log('the installed binary forwards an allowed call and refuses a denied one');
} catch (error) {
  failed = true;
  console.error(`\nthe packaged install failed: ${error.message.split('\n')[0]}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
