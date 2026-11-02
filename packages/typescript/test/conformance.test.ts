/**
 * The same conformance files the Python implementation runs.
 *
 * Not a translation of the Python tests. The same JSON, read from the same directory,
 * which is the only way "conformant" means one thing in two languages. If these two
 * implementations ever disagree, one of them is wrong about the specification rather
 * than about its own test suite.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EnforcementPoint, type Envelope, VERSION, evaluate, problems, validate } from '../src/index.ts';
import { SCHEMA } from '../src/schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const CONFORMANCE = join(ROOT, 'conformance');

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const listing = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

// ----------------------------------------------------------------- the schema copy

test('the inlined schema still matches the published one', () => {
  const published = read(join(ROOT, 'schema', 'intent-envelope-0.1.json'));
  assert.deepEqual(
    JSON.parse(JSON.stringify(SCHEMA)),
    published,
    'src/schema.ts has drifted from schema/intent-envelope-0.1.json. Run npm run gen:schema.',
  );
});

test('every field the schema requires is actually enforced', () => {
  // The conformance fixtures cover the omissions someone thought to write a file for.
  // This covers all of them, so a field added to the schema's required list cannot be
  // left unenforced, and the Envelope interface below stays an honest mirror of it:
  // a type looser than the schema compiles envelopes that then fail at runtime, and a
  // type stricter than the schema rejects envelopes the specification permits.
  const valid = read(join(ROOT, 'examples', listing(join(ROOT, 'examples'))[0]));
  for (const field of SCHEMA.required as readonly string[]) {
    const envelope = { ...valid };
    delete (envelope as Record<string, unknown>)[field];
    const found = problems(envelope);
    assert.ok(
      found.some((p) => p.message.includes(`"${field}" is a required property`)),
      `dropping the required field "${field}" was not reported`,
    );
  }
});

test('the exported VERSION matches the package manifest', () => {
  // Two places holding the same number is two places to forget. A consumer logging
  // VERSION in an audit trail should not be told a version that was never published.
  const { version } = read(join(here, '..', 'package.json'));
  assert.equal(VERSION, version);
});

// ----------------------------------------------------------------- section 6, parts 1 and 2

for (const file of listing(join(CONFORMANCE, 'valid'))) {
  test(`valid/${file} is accepted`, () => {
    assert.doesNotThrow(() => validate(read(join(CONFORMANCE, 'valid', file))));
  });
}

for (const file of listing(join(CONFORMANCE, 'invalid'))) {
  test(`invalid/${file} is rejected, naming the field`, () => {
    const found = problems(read(join(CONFORMANCE, 'invalid', file)));
    assert.ok(found.length > 0, `${file} was accepted and should not have been`);
    assert.ok(found.every((p) => p.path && p.message), 'a rejection must name the offending field');
  });
}

for (const file of listing(join(ROOT, 'examples')).filter((f) => f.endsWith('.json'))) {
  test(`examples/${file} is a valid envelope`, () => {
    assert.doesNotThrow(() => validate(read(join(ROOT, 'examples', file))));
  });
}

// ----------------------------------------------------------------- section 6, part 3

interface DecisionCase {
  name: string;
  spec_rule: number;
  decided_by: string;
  envelope?: Envelope;
  envelope_ref?: string;
  call: { tool: string; [key: string]: unknown };
  state: Record<string, unknown>;
  expect: { result: string; rule: string };
}

const decisionsDir = join(CONFORMANCE, 'decisions');
const cases: Array<{ file: string; body: DecisionCase }> = listing(decisionsDir).map((file) => {
  const body = read(join(decisionsDir, file)) as DecisionCase;
  if (body.envelope_ref) body.envelope = read(resolve(decisionsDir, body.envelope_ref));
  return { file, body };
});

test('the decision cases were found', () => {
  assert.ok(cases.length > 0, 'no decision cases in conformance/decisions');
});

test('every step of section 3 is covered', () => {
  const covered = new Set(cases.map((c) => c.body.spec_rule));
  const missing = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((step) => !covered.has(step));
  assert.deepEqual(missing, [], `no decision case covers section 3 step(s): ${missing}`);
});

for (const { file, body } of cases) {
  test(`decisions/${file}`, () => {
    const decision = evaluate(body.envelope as Envelope, body.call as never, body.state as never);

    assert.equal(decision.result, body.expect.result, `${body.name}: wrong result`);
    // The reason is not decoration. Section 5 requires the record to name the rule that
    // decided, and an operator reading the ledger acts on that field.
    assert.equal(decision.rule, body.expect.rule, `${body.name}: right answer, wrong reason`);

    const record = decision.record();
    for (const field of ['envelope_id', 'revision', 'agent_identity', 'tool', 'result', 'rule', 'decided_at']) {
      assert.ok(field in record, `the decision record has no ${field}, which section 5 requires`);
    }
    assert.equal(record.envelope_id, (body.envelope as Envelope).id);
  });
}

// ----------------------------------------------------------------- the demo

test('the Python demo scenario decides the same way here', () => {
  // The demo is the sales asset, and it exists only in the Python tree. Running its
  // envelope and plan through this implementation is what proves the two agree about
  // something larger than a single call.
  const envelope: Envelope = {
    intent_envelope: '0.1',
    id: 'invoice-reconciler',
    revision: 3,
    purpose: 'Reconcile this month’s supplier invoices against the ledger and email a summary to the AP team.',
    principal: { agent_identity: 'invoice-reconciler', on_behalf_of: 'finance.ap_team' },
    tools: {
      allow: [
        { name: 'read_invoice', constraints: { period: 'current_month' } },
        { name: 'ledger_search', constraints: { period: 'current_month', max_rows: 500 } },
        { name: 'send_email', constraints: { template: 'mismatch_summary' } },
      ],
      deny: ['issue_payment', 'http_request'],
    },
    data: { allow: ['invoices:read', 'ledger:read:current_month'], deny: ['payroll', 'bank.credentials'] },
    recipients: { allow: ['ap-team@example.com'], max_per_run: 3 },
    limits: { max_tool_calls: 20, max_spend_usd: 2.0, max_runtime_seconds: 300 },
    escalate: [{ when: 'mismatch_value_gbp > 10000', to: 'ap-duty-controller', timeout_seconds: 3600 }],
    on_no_response: 'deny',
  };

  const point = new EnforcementPoint(envelope);
  const results = [
    point.check('read_invoice', { invoice_id: '88413', period: 'current_month' }, { data: ['invoices:read'] }),
    point.check('ledger_search', { period: 'current_month', max_rows: 50 }, { data: ['ledger:read:current_month'] }),
    point.check('send_email', { template: 'mismatch_summary', to: 'ap-team@example.com' }),
    point.check('send_email', { template: 'mismatch_summary', to: 'collector@northgate-finance.example' }, { data: ['ledger:read:current_month'] }),
    point.check('issue_payment', { invoice_id: '88413', amount_gbp: 24900 }),
    point.check('send_email', { template: 'mismatch_summary', to: 'ap-team@example.com' }, { context: { mismatch_value_gbp: 24900 } }),
  ];

  assert.deepEqual(
    results.map((d) => d.result),
    ['allow', 'allow', 'allow', 'deny', 'deny', 'escalate'],
    'this implementation tells a different story than the Python demo',
  );
  assert.equal(results[3].rule, 'recipients', 'the exfiltration attempt stopped for the wrong reason');
  assert.equal(results[4].rule, 'tools.deny', 'the payment attempt stopped for the wrong reason');
  assert.deepEqual(point.summary(), { allow: 3, deny: 2, escalate: 1 });
});
