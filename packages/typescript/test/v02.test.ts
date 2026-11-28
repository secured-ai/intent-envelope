/**
 * Intent Envelope 0.2: amendments, component admission and the 0.2 schema.
 *
 * The decision cases for the four new rules run with every other case in
 * conformance.test.ts. These run the two new conformance folders, which the Python
 * implementation runs too, and pin that every 0.1 envelope still decides as before.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

import { admitComponent, canonical, checkAmendment, signAmendment, widening } from '../src/amend.ts';
import { hostMatches, evaluate, type Envelope } from '../src/evaluate.ts';
import { SCHEMA_02 } from '../src/schema.ts';
import { validate, problems } from '../src/validate.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const folder = (name: string) => {
  const dir = join(ROOT, 'conformance', name);
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const body = read(join(dir, f));
    for (const k of ['current_ref', 'envelope_ref']) if (body[k]) body[k.replace('_ref', '')] = read(resolve(dir, body[k]));
    return { file: f, body };
  });
};

test('src/schema.ts carries the 0.2 schema unchanged', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SCHEMA_02)), read(join(ROOT, 'schema/intent-envelope-0.2.json')));
});

test('a 0.2 envelope validates against 0.2, and its fields are refused under 0.1', () => {
  const env = read(join(ROOT, 'conformance/valid/refund-desk-0.2.json'));
  assert.doesNotThrow(() => validate(env));
  const asOld = { ...env, intent_envelope: '0.1' };
  const found = problems(asOld).map((p) => p.path);
  for (const field of ['egress', 'credentials', 'amendment', 'components']) assert.ok(found.includes(field), field);
  assert.ok(problems({ ...env, intent_envelope: '0.3' }).some((p) => p.path === 'intent_envelope'));
});

for (const { file, body } of folder('amendments')) {
  test(`amendments/${file}`, () => {
    const r = checkAmendment(body.current, body.proposed, body.signature, () => '2026-11-28T12:00:00Z');
    assert.equal(r.accepted, body.expect.accepted, `${body.name}: ${r.reasons.join('; ')}`);
    if (body.expect.widening) assert.deepEqual(r.widening, body.expect.widening);
    if (body.expect.reason) assert.ok(r.reasons.includes(body.expect.reason), `${body.name}: got ${JSON.stringify(r.reasons)}`);
    const rec = r.record();
    assert.equal(rec.result, body.expect.accepted ? 'accepted' : 'rejected');
    assert.match(rec.proposal_digest, /^sha256:[0-9a-f]{64}$/);
  });
}

for (const { file, body } of folder('components')) {
  test(`components/${file}`, () => {
    const r = admitComponent(body.envelope, body.manifest);
    assert.equal(r.admitted, body.expect.admitted);
    assert.deepEqual(r.reasons, body.expect.reasons);
  });
}

test('an envelope with no approvers can only be changed through review, never by signature', () => {
  const env = read(join(ROOT, 'conformance/valid/fintech-support-chatbot.json')) as Envelope;
  const { privateKey } = generateKeyPairSync('ed25519');
  const next = { ...env, revision: (env.revision ?? 1) + 1 };
  const r = checkAmendment(env, next, { approver: 'anyone', signature: signAmendment(next, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()) });
  assert.equal(r.accepted, false);
  assert.match(r.reasons[0]!, /names no approvers/);
});

test('canonical form: sorted keys, no whitespace, integer-valued numbers without a point', () => {
  assert.equal(canonical({ b: 2.0, a: [1.5, 'x', null, true], c: { z: 0, y: -3 } }), '{"a":[1.5,"x",null,true],"b":2,"c":{"y":-3,"z":0}}');
});

test('widening sees an approver being added, and on_no_response turning to allow', () => {
  const env = read(join(ROOT, 'conformance/valid/refund-desk-0.2.json'));
  const next = JSON.parse(JSON.stringify(env));
  next.amendment.approvers.push({ id: 'eve@example.com', public_key: env.amendment.approvers[0].public_key.replace('A', 'B') });
  next.on_no_response = 'allow';
  assert.deepEqual(widening(env, next), ['on_no_response changes from deny to allow', 'amendment.approvers gains eve@example.com']);
});

test('host matching: exact, subdomain, CIDR, case and trailing dot', () => {
  assert.ok(hostMatches('API.example.com.', 'api.example.com'));
  assert.ok(hostMatches('a.b.example.com', '.example.com'));
  assert.ok(hostMatches('a.example.com', '*.example.com'));
  assert.ok(!hostMatches('example.com', '.example.com'), 'a subdomain pattern never matches the bare domain');
  assert.ok(!hostMatches('badexample.com', '.example.com'));
  assert.ok(hostMatches('169.254.169.254', '169.254.0.0/16'));
  assert.ok(!hostMatches('169.255.0.1', '169.254.0.0/16'));
  assert.ok(hostMatches('10.1.2.3', '10.0.0.0/8'));
  assert.ok(!hostMatches('metadata.google.internal', '10.0.0.0/8'));
});

test('every 0.1 example decides exactly as before: the 0.2 rules read blocks 0.1 cannot have', () => {
  for (const f of readdirSync(join(ROOT, 'examples')).filter((x) => x.endsWith('.json'))) {
    const env = read(join(ROOT, 'examples', f)) as Envelope;
    const tool = env.tools.allow[0]!.name;
    const plain = evaluate(env, { tool }, { now: '2026-11-28T12:00:00Z' });
    const withFacts = evaluate(env, { tool, egress: ['anything.example'], processors: ['anyone'] }, { now: '2026-11-28T12:00:00Z' });
    assert.equal(withFacts.result, plain.result, f);
    assert.equal(withFacts.rule, plain.rule, f);
  }
});

test('the egress baseline pack: its example validates, and metadata and internal hosts are refused', () => {
  const env = read(join(ROOT, 'packs/egress-metadata-baseline/example-envelope.json')) as Envelope;
  const fragment = read(join(ROOT, 'packs/egress-metadata-baseline/egress.json'));
  assert.doesNotThrow(() => validate(env));
  assert.deepEqual(env.egress!.deny, fragment.egress.deny, 'the example uses the pack as published');
  const cred = { run_id: 'r1', issued_at: '2026-11-28T12:00:00Z', expires_at: '2026-11-28T12:10:00Z' };
  const state = { now: '2026-11-28T12:01:00Z', run_id: 'r1' };
  for (const host of ['169.254.169.254', '169.254.170.2', 'metadata.google.internal', '168.63.129.16', '10.0.4.2', '127.0.0.1', 'kubernetes.default.svc', 'db.prod.internal', 'help.example.com.attacker.net']) {
    const d = evaluate(env, { tool: 'fetch_url', egress: [host], credential: cred }, state);
    assert.equal(d.result, 'deny', host);
    assert.equal(d.rule, 'egress', host);
  }
  assert.equal(evaluate(env, { tool: 'fetch_url', egress: ['help.example.com'], credential: cred }, state).result, 'allow');
});
