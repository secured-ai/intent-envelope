// Generates src/schema.ts from the canonical schema. Never edit the output by hand.
// Run: node packages/typescript/tools/gen-schema.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const src = resolve(root, 'schema/intent-envelope-0.1.json');
const out = resolve(here, '../src/schema.ts');

const schema = JSON.parse(readFileSync(src, 'utf8'));
const header = `// GENERATED FILE. Do not edit by hand.
//
// Regenerate with:  node packages/typescript/tools/gen-schema.mjs
//
// A copy of schema/intent-envelope-0.1.json, inlined so the package has no runtime
// dependency and no file reads. A copy can drift from what it copies, so the test
// suite compares the two and fails if they stop matching: a validator enforcing a
// different schema than the one it points callers at is worse than no validator.

export const SCHEMA = `;

writeFileSync(out, header + JSON.stringify(schema, null, 2) + ' as const;\n');
console.log('wrote src/schema.ts');
