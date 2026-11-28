/**
 * Escalations held for a person, through a fake approval channel.
 *
 * Same standard as the rest of the suite: the claim is about what the upstream server
 * received, read from its own record, not about what the client was told.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { memoryLedger } from '../src/ledger.ts';
import { Relay, type EscalationAnswer, type EscalationHandler } from '../src/relay.ts';
import { ConfigError, parse } from '../src/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const UPSTREAM = resolve(here, 'fixtures/fake-upstream.mjs');
const ENVELOPE = JSON.parse(readFileSync(resolve(here, 'fixtures/ap-agent.json'), 'utf8'));

const scratches: string[] = [];
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

/** A channel whose answer the test gives, and which reports what it was asked. */
function channel() {
  const asked: Array<{ tool: string; signal: AbortSignal }> = [];
  let answer!: (a: EscalationAnswer) => void;
  let fail!: (e: Error) => void;
  const handler: EscalationHandler = {
    describe: () => 'a test channel',
    resolve: (call, _decision, signal) => {
      asked.push({ tool: call.tool, signal });
      return new Promise((res, rej) => {
        answer = res;
        fail = rej;
      });
    },
  };
  return { handler, asked, answer: (a: EscalationAnswer) => answer(a), fail: (e: Error) => fail(e) };
}

function setup(escalations?: EscalationHandler) {
  const scratch = mkdtempSync(join(tmpdir(), 'ie-mcp-esc-'));
  scratches.push(scratch);
  const log = join(scratch, 'upstream.jsonl');
  const upstream = spawn(process.execPath, [UPSTREAM], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, UPSTREAM_LOG: log } });
  const input = new PassThrough();
  const output = new PassThrough();
  const ledger = memoryLedger();
  const logs: string[] = [];
  const relay = new Relay({ envelope: ENVELOPE, ledger, upstream, input, output, log: (m) => logs.push(m), ...(escalations ? { escalations } : {}) });
  relay.start();

  const replies: Array<Record<string, any>> = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) replies.push(JSON.parse(line));
      i = buffer.indexOf('\n');
    }
  });

  const send = (m: unknown) => input.write(`${JSON.stringify(m)}\n`);
  const reply = async (id: number) => {
    for (let n = 0; n < 300; n++) {
      const r = replies.find((x) => x.id === id);
      if (r) return r;
      await new Promise((d) => setTimeout(d, 10));
    }
    throw new Error(`no reply to ${id}`);
  };
  const upstreamCalls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.method === 'tools/call')
      : [];
  const close = async () => {
    input.end();
    await new Promise<void>((d) => {
      upstream.on('exit', () => d());
      setTimeout(() => { upstream.kill('SIGKILL'); d(); }, 3000);
    });
  };
  const until = async (f: () => boolean) => {
    for (let n = 0; n < 300 && !f(); n++) await new Promise((d) => setTimeout(d, 10));
  };
  return { send, reply, replies, upstreamCalls, ledger, logs, relay, close, until };
}

const ESCALATING = {
  jsonrpc: '2.0', id: 7, method: 'tools/call',
  params: { name: 'send_email', arguments: { template: 'mismatch_summary', to: 'ap-team@example.com', mismatch_value_gbp: 24900 } },
};

test('an escalated call is held, then forwarded once a verified approval arrives', async () => {
  const c = channel();
  const s = setup(c.handler);
  try {
    s.send(ESCALATING);
    await s.until(() => c.asked.length > 0);
    assert.equal(c.asked[0]!.tool, 'send_email');
    await new Promise((d) => setTimeout(d, 100));
    assert.deepEqual(s.upstreamCalls(), [], 'nothing reaches the server while it waits');
    assert.equal(s.replies.find((r) => r.id === 7), undefined, 'and nothing is answered yet');

    c.answer({ outcome: 'allow', verified: true, reason: 'escalate: approved by dana', decided_by: 'dana', approval_id: 'apr_1' });
    const r = await s.reply(7);
    assert.ok(r.result, 'the server ran it and its result came back');
    assert.deepEqual(s.upstreamCalls().map((m) => m.params.arguments), [ESCALATING.params.arguments], 'the exact call that was approved');

    const ledger = s.ledger.entries();
    assert.deepEqual(ledger.map((e) => e.result), ['escalate', 'allow']);
    assert.equal((ledger[1] as any).approval.decided_by, 'dana');
    assert.equal((ledger[1] as any).approval.verified, true);
    assert.equal(s.relay.summary().escalate, 1);
  } finally {
    await s.close();
  }
});

test('an unverified allow is a deny', async () => {
  const c = channel();
  const s = setup(c.handler);
  try {
    s.send(ESCALATING);
    await s.until(() => c.asked.length > 0);
    c.answer({ outcome: 'allow', verified: false, reason: 'someone said yes' });
    const r = await s.reply(7);
    assert.equal(r.error?.code, -32000);
    assert.deepEqual(s.upstreamCalls(), []);
    assert.deepEqual(s.ledger.entries().map((e) => e.result), ['escalate', 'deny']);
  } finally {
    await s.close();
  }
});

test('a refusal, and a channel that fails, both deny with the reason', async () => {
  const c = channel();
  const s = setup(c.handler);
  try {
    s.send(ESCALATING);
    await s.until(() => c.asked.length > 0);
    c.answer({ outcome: 'deny', verified: true, reason: 'escalate: nobody answered for ap-duty-controller' });
    const r = await s.reply(7);
    assert.equal(r.error?.code, -32000);
    assert.match(r.error?.message, /escalated to ap-duty-controller, and not approved: escalate: nobody answered/);

    s.send({ ...ESCALATING, id: 8 });
    await s.until(() => c.asked.length > 1);
    c.fail(new Error('connection refused'));
    const r2 = await s.reply(8);
    assert.match(r2.error?.message, /the approval channel failed: connection refused/);
    assert.deepEqual(s.upstreamCalls(), []);
  } finally {
    await s.close();
  }
});

test('other calls keep flowing while one waits', async () => {
  const c = channel();
  const s = setup(c.handler);
  try {
    s.send(ESCALATING);
    await s.until(() => c.asked.length > 0);
    s.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'read_invoice', arguments: { period: 'current_month' } } });
    const r = await s.reply(9);
    assert.ok(r.result);
    c.answer({ outcome: 'deny', verified: true, reason: 'refused' });
    await s.reply(7);
  } finally {
    await s.close();
  }
});

test('a cancelled call withdraws its wait, is never forwarded, and gets no reply', async () => {
  const c = channel();
  const s = setup(c.handler);
  try {
    s.send(ESCALATING);
    await s.until(() => c.asked.length > 0);
    s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'user gave up' } });
    await s.until(() => c.asked[0]!.signal.aborted);
    assert.equal(c.asked[0]!.signal.aborted, true);
    // Even a late allow does not run it.
    c.answer({ outcome: 'allow', verified: true, reason: 'too late' });
    await new Promise((d) => setTimeout(d, 200));
    assert.deepEqual(s.upstreamCalls(), []);
    assert.equal(s.replies.find((r) => r.id === 7), undefined);
  } finally {
    await s.close();
  }
});

test('without a channel, escalation is still refused with who must approve it', async () => {
  const s = setup();
  try {
    s.send(ESCALATING);
    const r = await s.reply(7);
    assert.equal(r.error?.code, -32001);
    assert.match(r.error?.message, /ap-duty-controller/);
  } finally {
    await s.close();
  }
});

test('the supervisor settings go together, and must be https off this host', () => {
  const base = ['--envelope', resolve(here, 'fixtures/ap-agent.json')];
  const tail = ['--', 'node', 'x.mjs'];
  assert.throws(() => parse([...base, '--supervisor', 'https://sup.internal', ...tail]), (e: unknown) => e instanceof ConfigError && /give all four or none/.test(e.message));
  const key = resolve(here, 'fixtures/ap-agent.json');
  assert.throws(
    () => parse([...base, '--supervisor', 'http://sup.internal', '--supervisor-caller', 'h', '--supervisor-key', key, '--supervisor-pub', key, ...tail]),
    /must be https/,
  );
  const ok = parse([...base, '--supervisor', 'http://127.0.0.1:8443', '--supervisor-caller', 'h', '--supervisor-key', key, '--supervisor-pub', key, ...tail]);
  assert.equal(ok.supervisor?.callerId, 'h');
});
