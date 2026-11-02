#!/usr/bin/env node
/**
 * Run both implementations over every decision case and diff the answers.
 *
 * Each package passing its own suite proves only that it agrees with itself. This
 * proves the two agree with each other, which is the claim the specification actually
 * makes: an envelope means the same thing whichever enforcement point reads it.
 *
 * Exits non-zero if any case gets a different result or a different rule. A difference
 * in the prose detail is reported but does not fail, because section 6 binds the
 * verdict and the rule rather than the wording.
 *
 * Run: node tools/cross-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'conformance', 'decisions');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

const { evaluate } = await import(join(ROOT, 'packages/typescript/src/index.ts'));

const load = (file) => {
  const body = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  if (body.envelope_ref) body.envelope = JSON.parse(readFileSync(resolve(DIR, body.envelope_ref), 'utf8'));
  return body;
};

const typescript = Object.fromEntries(
  files.map((file) => {
    const c = load(file);
    const d = evaluate(c.envelope, c.call, c.state);
    return [file, { result: d.result, rule: d.rule, detail: d.detail }];
  }),
);

const PY = `
import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'packages/python/src'))})
from intent_envelope.evaluate import Call, RunState, evaluate
d = pathlib.Path(${JSON.stringify(DIR)})
out = {}
for f in sorted(p for p in d.iterdir() if p.suffix == '.json'):
    c = json.loads(f.read_text())
    if 'envelope_ref' in c:
        c['envelope'] = json.loads((d / c['envelope_ref']).resolve().read_text())
    r = evaluate(c['envelope'], Call(**c['call']), RunState(**c['state']))
    out[f.name] = {'result': r.result, 'rule': r.rule, 'detail': r.detail}
print(json.dumps(out))
`;

const python = JSON.parse(execFileSync('python3', ['-c', PY], { encoding: 'utf8' }));

let verdictMismatch = 0;
let wordingDiff = 0;

for (const file of files) {
  const ts = typescript[file];
  const py = python[file];
  if (!py) {
    verdictMismatch += 1;
    console.log(`MISSING   ${file} produced no Python result`);
    continue;
  }
  if (ts.result !== py.result || ts.rule !== py.rule) {
    verdictMismatch += 1;
    console.log(`DISAGREE  ${file}`);
    console.log(`  typescript: ${ts.result} / ${ts.rule}`);
    console.log(`  python:     ${py.result} / ${py.rule}`);
  } else if (ts.detail !== py.detail) {
    wordingDiff += 1;
    console.log(`wording   ${file}`);
    console.log(`  typescript: ${ts.detail}`);
    console.log(`  python:     ${py.detail}`);
  }
}

const agreeing = files.length - verdictMismatch;
console.log(
  `\n${files.length} cases, ${agreeing} agreeing on result and rule` +
    (wordingDiff ? `, ${wordingDiff} differing only in wording` : ', wording identical'),
);
process.exit(verdictMismatch ? 1 : 0);
