// Generates src/schema.ts from the canonical schemas. Never edit the output by hand.
// Run: node packages/typescript/tools/gen-schema.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = resolve(here, '../src/schema.ts');
const read = (v) => JSON.parse(readFileSync(resolve(root, `schema/intent-envelope-${v}.json`), 'utf8'));

const header = `// GENERATED FILE. Do not edit by hand.
//
// Regenerate with:  node packages/typescript/tools/gen-schema.mjs
//
// Copies of schema/intent-envelope-0.1.json and schema/intent-envelope-0.2.json,
// inlined so the package has no runtime dependency and no file reads. A copy can drift
// from what it copies, so the test suite compares them and fails if they stop
// matching: a validator enforcing a different schema than the one it points callers at
// is worse than no validator.

`;

writeFileSync(out, header +
  `export const SCHEMA = ${JSON.stringify(read('0.1'), null, 2)} as const;\n\n` +
  `export const SCHEMA_02 = ${JSON.stringify(read('0.2'), null, 2)} as const;\n\n` +
  `/** Every version this package validates and evaluates. */\n` +
  `export const SCHEMAS = { '0.1': SCHEMA, '0.2': SCHEMA_02 } as const;\n`);
console.log('wrote src/schema.ts');
