#!/usr/bin/env node
/**
 * Pack the package, install it the way a customer would, and make a decision with it.
 *
 * The test suite runs against the source tree, where Node happily strips the types out
 * of a .ts file. It cannot see the one failure mode that matters most at publish time:
 * Node refuses to strip types for anything under node_modules, so a package whose
 * exports point at its .ts sources throws ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
 * on the consumer's very first import. A suite of forty passing tests says nothing
 * about that, because none of them import the package the way a consumer does.
 *
 * So this builds the tarball, installs it into a scratch directory with no access to
 * this repo, and runs a real envelope through the installed copy. If the build, the
 * exports map, or the files list is wrong, this fails and CI goes red before anything
 * reaches npm.
 *
 * Run: node tools/consumer-smoke.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function exec(cmd, args, cwd, shell = false) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell,
  });
}

/**
 * Run npm in a way that works on every platform.
 *
 * On Windows `npm` is a .cmd shim, and since the fix for CVE-2024-27980 Node refuses
 * to spawn .cmd files without a shell, so execFileSync('npm', ...) fails with ENOENT.
 * Running npm's own entry point through this Node binary avoids the shim altogether
 * and behaves identically everywhere. npm sets npm_execpath when it runs a script, so
 * `npm run smoke` takes that path; a direct `node tools/consumer-smoke.mjs` falls back
 * to the shim, quoting arguments because a Windows profile path contains spaces.
 */
function npm(args, cwd) {
  if (process.env.npm_execpath) {
    return exec(process.execPath, [process.env.npm_execpath, ...args], cwd);
  }
  if (process.platform === 'win32') {
    const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a));
    return exec('npm.cmd', quoted, cwd, true);
  }
  return exec('npm', args, cwd);
}

const scratch = mkdtempSync(join(tmpdir(), 'intent-envelope-consumer-'));
let failed = false;

try {
  // prepack runs the build, so this is the same tarball `npm publish` would upload.
  const tarball = npm(['pack', '--silent', '--pack-destination', scratch], PKG).trim();
  console.log(`packed ${tarball}`);

  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  npm(['install', '--silent', '--no-audit', '--no-fund', join(scratch, tarball)], scratch);

  const app = `
import { EnforcementPoint, Refused, evaluate, validate } from 'intent-envelope';
import { strict as assert } from 'node:assert';

const envelope = {
  intent_envelope: '0.1',
  id: 'invoice-reconciler',
  revision: 1,
  purpose: 'Reconcile supplier invoices against the ledger and email a summary to the AP team.',
  principal: { agent_identity: 'invoice-reconciler', on_behalf_of: 'finance.ap_team' },
  tools: { allow: [{ name: 'send_email', constraints: { template: 'summary' } }], deny: ['issue_payment'] },
  recipients: { allow: ['ap-team@example.com'], max_per_run: 2 },
  limits: { max_tool_calls: 10, max_spend_usd: 2.0 },
  on_no_response: 'deny',
};

validate(envelope);

const point = new EnforcementPoint(envelope);
assert.equal(point.check('send_email', { template: 'summary', to: 'ap-team@example.com' }).result, 'allow');

const exfil = point.check('send_email', { template: 'summary', to: 'collector@elsewhere.example' });
assert.equal(exfil.result, 'deny');
assert.equal(exfil.rule, 'recipients');

const payment = point.check('issue_payment', { amount: 24900 });
assert.equal(payment.result, 'deny');
assert.equal(payment.rule, 'tools.deny');

assert.deepEqual(point.summary(), { allow: 1, deny: 2, escalate: 0 });
assert.throws(() => point.enforce('issue_payment', { amount: 1 }), Refused);
assert.equal(evaluate(envelope, { tool: 'issue_payment' }, {}).rule, 'tools.deny');

// The package claims to ship types. An install with no .d.ts still imports fine, so
// the claim has to be checked rather than assumed.
const { createRequire } = await import('node:module');
const manifest = createRequire(import.meta.url)('intent-envelope/package.json');
const types = manifest.exports?.['.']?.types;
assert.ok(types, 'the exports map declares no types entry');
await import('node:fs').then(({ accessSync }) =>
  accessSync(new URL(types, new URL('./node_modules/intent-envelope/', import.meta.url))),
);

console.log('the installed package validates, decides, refuses, and ships types');
`;
  writeFileSync(join(scratch, 'app.mjs'), app);
  // process.execPath rather than 'node', which need not be on PATH.
  process.stdout.write(exec(process.execPath, ['app.mjs'], scratch));
} catch (error) {
  failed = true;
  console.error(`\nthe packaged install failed: ${error.message.split('\n')[0]}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
