/**
 * 0.2 component admission in the proxy: refused at start, and a tool the manifest never
 * declared is hidden and refused even when the envelope grants it.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConfigError, parse } from '../src/config.ts';
import { memoryLedger } from '../src/ledger.ts';
import { Relay } from '../src/relay.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ENVELOPE_PATH = resolve(here, 'fixtures/ap-agent.json');
const ENVELOPE = JSON.parse(readFileSync(ENVELOPE_PATH, 'utf8'));
const UPSTREAM = resolve(here, 'fixtures/fake-upstream.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'ie-mcp-comp-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function manifest(name: string, body: object): string {
  const p = join(scratch, `${name}.json`);
  writeFileSync(p, JSON.stringify({ name, ...body }));
  return p;
}
const argv = (...extra: string[]) => ['--envelope', ENVELOPE_PATH, ...extra, '--', 'node', 'x.mjs'];

test('a component inside the envelope is admitted', () => {
  const cfg = parse(argv('--component', manifest('invoices', { tools: ['read_invoice', 'ledger_search'] })));
  assert.equal(cfg.component?.name, 'invoices');
});

test('a component bringing an ungranted tool, or reaching any host under an envelope with no egress, is refused at start', () => {
  assert.throws(() => parse(argv('--component', manifest('pay', { tools: ['read_invoice', 'issue_payment'] }))),
    (e: unknown) => e instanceof ConfigError && /issue_payment is refused by the envelope/.test(e.message));
  assert.throws(() => parse(argv('--component', manifest('fetch', { tools: ['read_invoice'], egress: ['collector.example.net'] }))),
    (e: unknown) => e instanceof ConfigError && /declares no egress/.test(e.message));
});

test('an envelope that requires a manifest refuses to start without one', () => {
  const p = join(scratch, 'requires.json');
  writeFileSync(p, JSON.stringify({ ...ENVELOPE, intent_envelope: '0.2', components: { require_manifest: true } }));
  assert.throws(() => parse(['--envelope', p, '--', 'node', 'x.mjs']), /requires a component manifest/);
});

test('a tool the manifest never declared is hidden and refused, though the envelope grants it', async () => {
  const log = join(scratch, 'upstream.jsonl');
  const upstream = spawn(process.execPath, [UPSTREAM], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, UPSTREAM_LOG: log } });
  const input = new PassThrough(), output = new PassThrough();
  const ledger = memoryLedger();
  const logs: string[] = [];
  new Relay({ envelope: ENVELOPE, ledger, upstream, input, output, log: (m) => logs.push(m),
    component: { name: 'invoices', tools: ['read_invoice'] } }).start();
  const replies: any[] = [];
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n')) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) replies.push(JSON.parse(l)); } });
  const reply = async (id: number) => { for (let n = 0; n < 300; n++) { const r = replies.find((x) => x.id === id); if (r) return r; await new Promise((d) => setTimeout(d, 10)); } throw new Error('no reply'); };
  try {
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    const list = await reply(1);
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['read_invoice']);
    assert.ok(logs.some((l) => /does not declare, hidden and refused: .*ledger_search/.test(l)));

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ledger_search', arguments: { period: 'current_month' } } }) + '\n');
    const r = await reply(2);
    assert.equal(r.error.code, -32000);
    assert.equal(r.error.data.intent_envelope.rule, 'components');
    await new Promise((d) => setTimeout(d, 150));
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('tools/call')) : [];
    assert.deepEqual(calls, [], 'it never reached the server');
    assert.equal(ledger.entries().at(-1)?.rule, 'components');
  } finally {
    input.end();
    await new Promise<void>((d) => { upstream.on('exit', () => d()); setTimeout(() => { upstream.kill('SIGKILL'); d(); }, 3000); });
  }
});
