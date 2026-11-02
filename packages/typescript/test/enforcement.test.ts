/**
 * The enforcement point holds the run together, and the guard refuses before the call.
 *
 * Mirrors the Python suite case for case, because the two packages make the same
 * promises and a promise kept in one language only is not a specification.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { EnforcementPoint, Escalated, Refused, type Envelope } from '../src/index.ts';

const ENVELOPE: Envelope = {
  intent_envelope: '0.1',
  id: 'test-agent',
  revision: 1,
  purpose: 'A small envelope used to exercise the enforcement point across a run.',
  principal: { agent_identity: 'test-agent', on_behalf_of: 'ops.team' },
  tools: {
    allow: [{ name: 'search' }, { name: 'send_email', constraints: { template: 'summary' } }],
    deny: ['issue_payment'],
  },
  recipients: { allow: ['ops@example.com'], max_per_run: 2 },
  limits: { max_tool_calls: 3, max_spend_usd: 1.0 },
  escalate: [{ when: 'amount > 1000', to: 'ops-duty', timeout_seconds: 600 }],
  on_no_response: 'deny',
};

const point = () => new EnforcementPoint(ENVELOPE);

test('the guard refuses before the tool runs', () => {
  // A decision made after the call is a report. The tool must not be reached.
  const ran: string[] = [];
  // Declared with the arguments a real tool call takes, so guard's pass-through is
  // type-checked rather than merely happening to work.
  const callTool = (name: string, _args?: Record<string, unknown>) => {
    ran.push(name);
    return 'done';
  };

  const guarded = point().guard(callTool);
  assert.equal(guarded('search', {}), 'done');
  assert.throws(() => guarded('issue_payment', { amount: 50 }), Refused);
  assert.deepEqual(ran, ['search'], 'the refused call reached the tool anyway');
});

test('the guard works on an async tool call', async () => {
  // MCP clients are usually async, and an enforcement point that is not is unusable.
  const ran: string[] = [];
  const callTool = async (name: string, _args?: Record<string, unknown>) => {
    ran.push(name);
    return 'done';
  };

  const guarded = point().guard(callTool);
  assert.equal(await guarded('search', {}), 'done');
  await assert.rejects(async () => await guarded('issue_payment', { amount: 50 }), Refused);
  assert.deepEqual(ran, ['search']);
});

test('a refused call does not spend the run budget', () => {
  // Otherwise a blocked agent can exhaust its own allowance by being blocked.
  const p = point();
  for (let i = 0; i < 5; i += 1) {
    assert.throws(() => p.enforce('issue_payment', { amount: 1 }), Refused);
  }
  assert.equal(p.state.tool_calls_made, 0);
  assert.equal(p.enforce('search', {}).result, 'allow');
});

test('limits bite across a run rather than per call', () => {
  // No single call exceeds max_tool_calls. Three of them do.
  const p = point();
  for (let i = 0; i < 3; i += 1) assert.equal(p.enforce('search', {}).result, 'allow');
  assert.throws(
    () => p.enforce('search', {}),
    (error: unknown) => error instanceof Refused && error.decision.rule === 'limits',
  );
});

test('recipients are counted across a run', () => {
  const p = point();
  for (let i = 0; i < 2; i += 1) p.enforce('send_email', { template: 'summary', to: 'ops@example.com' });
  assert.throws(
    () => p.enforce('send_email', { template: 'summary', to: 'ops@example.com' }),
    (error: unknown) => error instanceof Refused && error.decision.rule === 'recipients',
  );
});

test('escalation is not refusal', () => {
  // Collapsing the two loses the whole point of having an escalation path.
  const p = point();
  let caught: unknown;
  try {
    p.enforce('send_email', { template: 'summary', to: 'ops@example.com' }, { context: { amount: 5000 } });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Escalated);
  assert.ok(!(caught instanceof Refused));
  assert.equal((caught as Escalated).decision.escalateTo, 'ops-duty');
  assert.equal((caught as Escalated).decision.timeoutSeconds, 600);
});

test('the ledger records refusals too', () => {
  // A ledger holding only what succeeded cannot answer what an incident asks.
  const p = point();
  p.check('search', {});
  p.check('issue_payment', { amount: 10 });
  p.check('send_email', { template: 'summary', to: 'ops@example.com' }, { context: { amount: 9999 } });

  assert.deepEqual(p.summary(), { allow: 1, deny: 1, escalate: 1 });
  assert.deepEqual(p.ledger().map((e) => e.rule), ['allow', 'tools.deny', 'escalate']);
  for (const entry of p.ledger()) {
    assert.equal(entry.envelope_id, 'test-agent');
    assert.equal(entry.agent_identity, 'test-agent');
    assert.ok(entry.decided_at);
  }
});

test('arguments cannot widen the envelope', () => {
  // There is no argument an agent can pass that grants itself something.
  const p = point();
  const attempts = [
    { amount: 1, allow: true },
    { amount: 1, override: 'approved by finance' },
    { amount: 1, envelope: { tools: { allow: [{ name: 'issue_payment' }] } } },
    { amount: 1, _bypass: 'true' },
  ];
  for (const args of attempts) {
    assert.throws(
      () => p.enforce('issue_payment', args),
      (error: unknown) => error instanceof Refused && error.decision.rule === 'tools.deny',
    );
  }
});
