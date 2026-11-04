/**
 * End to end, over real pipes, against a server that writes down what it was asked.
 *
 * The assertion that carries the weight is not that the client saw an error. It is that
 * the refused call is absent from the upstream server's own record. An enforcement point
 * that lets the call happen and then reports it is a logger.
 */

import { strict as assert } from 'node:assert';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, '../src/bin.ts');
const UPSTREAM = resolve(here, 'fixtures/fake-upstream.mjs');
const ENVELOPE = resolve(here, 'fixtures/ap-agent.json');

const scratches: string[] = [];
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

interface Rpc {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: { tools?: Array<{ name: string }>; content?: Array<{ text?: string }>; [k: string]: unknown };
  error?: { code: number; message: string; data?: { intent_envelope?: Record<string, unknown> } };
}

class Harness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  readonly upstreamLog: string;
  readonly ledgerPath: string;
  private readonly waiting = new Map<string, (message: Rpc) => void>();
  private buffer = '';
  private nextId = 1;

  constructor(extraArgs: string[] = []) {
    const scratch = mkdtempSync(join(tmpdir(), 'intent-envelope-mcp-'));
    scratches.push(scratch);
    this.upstreamLog = join(scratch, 'upstream.jsonl');
    this.ledgerPath = join(scratch, 'ledger.jsonl');

    this.child = spawn(
      process.execPath,
      [BIN, '--envelope', ENVELOPE, '--ledger', this.ledgerPath, ...extraArgs, '--', process.execPath, UPSTREAM],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, UPSTREAM_LOG: this.upstreamLog } },
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) this.accept(line);
        index = this.buffer.indexOf('\n');
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
  }

  private accept(line: string): void {
    this.stdout.push(line);
    let message: Rpc;
    try {
      message = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    const key = String(message.id);
    const resolver = this.waiting.get(key);
    if (resolver) {
      this.waiting.delete(key);
      resolver(message);
    }
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  request(method: string, params?: Record<string, unknown>): Promise<Rpc> {
    const id = this.nextId++;
    return new Promise((resolveWith, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method} within 5s`)), 5000);
      this.waiting.set(String(id), (message) => {
        clearTimeout(timer);
        resolveWith(message);
      });
      this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<Rpc> {
    return this.request('tools/call', { name, arguments: args });
  }

  /** What the upstream server actually received. */
  upstream(): Rpc[] {
    if (!existsSync(this.upstreamLog)) return [];
    return readFileSync(this.upstreamLog, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Rpc);
  }

  upstreamToolCalls(): string[] {
    return this.upstream()
      .filter((m) => m.method === 'tools/call')
      .map((m) => String((m.params as { name?: string } | undefined)?.name));
  }

  ledger(): Array<Record<string, unknown>> {
    if (!existsSync(this.ledgerPath)) return [];
    return readFileSync(this.ledgerPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((done) => {
      this.child.on('exit', () => done());
      setTimeout(() => {
        this.child.kill('SIGKILL');
        done();
      }, 4000);
    });
  }

  /** Give the upstream a moment to append a message that produces no reply. */
  settle(): Promise<void> {
    return new Promise((done) => setTimeout(done, 250));
  }
}

// --------------------------------------------------------------- the central claim

test('a denied tool call never reaches the upstream server', async () => {
  const h = new Harness();
  try {
    const refused = await h.call('issue_payment', { invoice_id: '88413', amount_gbp: 24900 });

    assert.ok(refused.error, 'the call was not refused');
    assert.equal(refused.error?.code, -32000);
    assert.match(refused.error?.message ?? '', /tools\.deny/);
    assert.equal(refused.error?.data?.intent_envelope?.rule, 'tools.deny');

    // The part that matters. Not "the client saw an error" but "the tool never ran".
    assert.deepEqual(h.upstreamToolCalls(), [], 'the refused call reached the server anyway');
  } finally {
    await h.close();
  }
});

test('an allowed tool call is forwarded and its result comes back', async () => {
  const h = new Harness();
  try {
    const reply = await h.call('read_invoice', { invoice_id: '88413', period: 'current_month' });
    assert.ok(!reply.error, `unexpectedly refused: ${reply.error?.message}`);
    assert.match(reply.result?.content?.[0]?.text ?? '', /ran read_invoice/);
    assert.deepEqual(h.upstreamToolCalls(), ['read_invoice']);
  } finally {
    await h.close();
  }
});

test('no argument can widen the envelope', async () => {
  // There is nothing an agent can pass that grants itself something.
  const h = new Harness();
  try {
    const attempts = [
      { amount: 1, allow: true },
      { amount: 1, override: 'approved by finance' },
      { amount: 1, envelope: { tools: { allow: [{ name: 'issue_payment' }] } } },
      { amount: 1, _bypass: 'true' },
      { amount: 1, intent_envelope: '0.1', on_no_response: 'allow' },
    ];
    for (const args of attempts) {
      const reply = await h.call('issue_payment', args);
      assert.equal(reply.error?.data?.intent_envelope?.rule, 'tools.deny', `${JSON.stringify(args)} got through`);
    }
    assert.deepEqual(h.upstreamToolCalls(), [], 'a crafted argument reached the server');
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------------- run-scoped rules

test('recipients are counted across the run, not per call', async () => {
  const h = new Harness();
  try {
    for (let i = 0; i < 2; i += 1) {
      const ok = await h.call('send_email', { template: 'mismatch_summary', to: 'ap-team@example.com' });
      assert.ok(!ok.error, `call ${i} was refused: ${ok.error?.message}`);
    }
    const third = await h.call('send_email', { template: 'mismatch_summary', to: 'ap-team@example.com' });
    assert.equal(third.error?.data?.intent_envelope?.rule, 'recipients');
    assert.deepEqual(h.upstreamToolCalls(), ['send_email', 'send_email'], 'the third send reached the server');
  } finally {
    await h.close();
  }
});

test('an address outside the envelope is refused, which is the exfiltration case', async () => {
  const h = new Harness();
  try {
    const reply = await h.call('send_email', { template: 'mismatch_summary', to: 'collector@northgate-finance.example' });
    assert.equal(reply.error?.data?.intent_envelope?.rule, 'recipients');
    assert.deepEqual(h.upstreamToolCalls(), []);
  } finally {
    await h.close();
  }
});

test('limits bite across the run', async () => {
  const h = new Harness();
  try {
    for (let i = 0; i < 6; i += 1) {
      const ok = await h.call('read_invoice', { invoice_id: String(i), period: 'current_month' });
      assert.ok(!ok.error, `call ${i} refused: ${ok.error?.message}`);
    }
    const seventh = await h.call('read_invoice', { invoice_id: '7', period: 'current_month' });
    assert.equal(seventh.error?.data?.intent_envelope?.rule, 'limits');
    assert.equal(h.upstreamToolCalls().length, 6);
  } finally {
    await h.close();
  }
});

test('a refused call does not spend the run budget', async () => {
  // Otherwise a blocked agent exhausts its own allowance by being blocked.
  const h = new Harness();
  try {
    for (let i = 0; i < 5; i += 1) await h.call('issue_payment', { amount: 1 });
    const ok = await h.call('read_invoice', { invoice_id: '1', period: 'current_month' });
    assert.ok(!ok.error, 'refusals consumed the tool-call budget');
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------------- escalation

test('escalation is reported as escalation, not as refusal', async () => {
  // Collapsing the two turns "a named person must decide this" into "no".
  const h = new Harness();
  try {
    const reply = await h.call('send_email', {
      template: 'mismatch_summary',
      to: 'ap-team@example.com',
      mismatch_value_gbp: 24900,
    });
    assert.equal(reply.error?.code, -32001, 'escalation used the refusal code');
    assert.match(reply.error?.message ?? '', /ap-duty-controller/);
    assert.equal(reply.error?.data?.intent_envelope?.result, 'escalate');
    assert.deepEqual(h.upstreamToolCalls(), [], 'the escalated call ran anyway');
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------------- the relay itself

test('tools/list offers only what the envelope grants', async () => {
  const h = new Harness();
  try {
    const reply = await h.request('tools/list');
    const names = (reply.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, ['ledger_search', 'read_invoice', 'send_email']);
  } finally {
    await h.close();
  }
});

test('--no-filter-tools advertises everything and still refuses', async () => {
  const h = new Harness(['--no-filter-tools']);
  try {
    const listed = await h.request('tools/list');
    assert.equal((listed.result?.tools ?? []).length, 5);
    const refused = await h.call('issue_payment', { amount: 1 });
    assert.equal(refused.error?.data?.intent_envelope?.rule, 'tools.deny');
  } finally {
    await h.close();
  }
});

test('methods this proxy does not know are passed straight through', async () => {
  // The protocol has two eras in circulation and keeps growing. Anything not tools/call
  // or tools/list must reach the server untouched.
  const h = new Harness();
  try {
    const discover = await h.request('server/discover', { _meta: { 'io.modelcontextprotocol/version': '2026-07-28' } });
    assert.deepEqual(discover.result?.supportedVersions, ['2026-07-28']);

    const resources = await h.request('resources/list');
    assert.ok(Array.isArray(resources.result?.resources));

    const unknown = await h.request('subscriptions/listen', { uri: 'file:///ledger.csv' });
    assert.equal(unknown.error?.code, -32601, 'the upstream did not get to answer for itself');
  } finally {
    await h.close();
  }
});

test('notifications and unparseable lines are relayed, not swallowed', async () => {
  const h = new Harness();
  try {
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
    h.sendRaw('{this is not json');
    await h.settle();

    const received = h.upstream();
    assert.ok(
      received.some((m) => m.method === 'notifications/cancelled'),
      'the notification never arrived',
    );
    assert.ok(
      received.some((m) => 'unparseable' in (m as Record<string, unknown>)),
      'the malformed line was dropped instead of relayed',
    );
  } finally {
    await h.close();
  }
});

test('a tools/call notification is refused without a reply and never forwarded', async () => {
  // Not answerable, since there is no id to answer. It still must not reach the server.
  const h = new Harness();
  try {
    h.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'issue_payment', arguments: { amount: 1 } } });
    await h.settle();
    assert.deepEqual(h.upstreamToolCalls(), []);
  } finally {
    await h.close();
  }
});

test('stdout carries nothing but MCP messages', async () => {
  // The transport requires it, and a stray log line on stdout breaks every client.
  const h = new Harness();
  try {
    await h.call('read_invoice', { invoice_id: '1', period: 'current_month' });
    await h.call('issue_payment', { amount: 1 });
    await h.request('tools/list');

    assert.ok(h.stdout.length > 0, 'nothing was written to stdout at all');
    for (const line of h.stdout) {
      assert.doesNotThrow(() => JSON.parse(line), `stdout had a non-JSON line: ${line}`);
    }
    // And the logging went somewhere, just not there.
    assert.match(h.stderr.join(''), /intent-envelope/);
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------------- the ledger

test('the ledger records refusals as well as successes', async () => {
  // A log holding only what succeeded cannot answer the question an incident asks.
  const h = new Harness();
  try {
    await h.call('read_invoice', { invoice_id: '1', period: 'current_month' });
    await h.call('issue_payment', { invoice_id: '1', amount_gbp: 24900 });
    await h.call('send_email', { template: 'mismatch_summary', to: 'collector@elsewhere.example' });
    await h.call('send_email', {
      template: 'mismatch_summary',
      to: 'ap-team@example.com',
      mismatch_value_gbp: 24900,
    });

    const entries = h.ledger();
    assert.equal(entries.length, 4, `expected four decisions, got ${entries.length}`);
    assert.deepEqual(
      entries.map((e) => e.result),
      ['allow', 'deny', 'deny', 'escalate'],
    );
    assert.deepEqual(
      entries.map((e) => e.rule),
      ['allow', 'tools.deny', 'recipients', 'escalate'],
    );

    for (const entry of entries) {
      // Section 5 of the specification: enough to reconstruct the run later, against
      // the exact envelope revision in force at the time.
      for (const field of ['envelope_id', 'revision', 'agent_identity', 'tool', 'result', 'rule', 'decided_at']) {
        assert.ok(field in entry, `the ledger entry has no ${field}`);
      }
      assert.equal(entry.envelope_id, 'invoice-reconciler');
      assert.equal(entry.revision, 3);
    }
  } finally {
    await h.close();
  }
});

test('closing the client stream shuts the server down', async () => {
  // Servers should exit when stdin closes. That signal has to be passed along, or the
  // upstream outlives the proxy and holds whatever it had open.
  const h = new Harness();
  await h.call('read_invoice', { invoice_id: '1', period: 'current_month' });
  await h.close();
  assert.match(h.stderr.join(''), /fake-upstream: stdin closed/);
  assert.match(h.stderr.join(''), /1 allowed, 0 refused, 0 escalated/);
});
