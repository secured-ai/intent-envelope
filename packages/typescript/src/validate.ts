/**
 * Validate an envelope against the published schema, with no dependencies.
 *
 * This implements exactly the fourteen JSON Schema keywords the intent envelope schema
 * uses, rather than pulling in a general validator. A security package whose install
 * drags in a dependency tree is a worse security package, and the subset is small
 * enough to read in one sitting.
 *
 * Unknown keywords are not ignored. `assertKeywordsSupported` runs at module load and
 * throws, so a schema that grows a rule this cannot check fails loudly instead of
 * silently reporting envelopes valid against rules nobody enforced.
 */

import { SCHEMA } from './schema.ts';

export interface Problem {
  path: string;
  message: string;
}

export class ValidationError extends Error {
  readonly problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.map((p) => `${p.path}: ${p.message}`).join('; '));
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

export class UnsupportedKeyword extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedKeyword';
  }
}

const SUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties',
  'const', 'enum', 'format', 'items', 'minItems',
  'minLength', 'maxLength', 'minimum', 'minProperties', 'pattern',
]);

type Schema = Record<string, any>;

export function assertKeywordsSupported(schema: unknown, path = '#'): void {
  if (Array.isArray(schema)) {
    schema.forEach((s, i) => assertKeywordsSupported(s, `${path}/${i}`));
    return;
  }
  if (!schema || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema as Schema)) {
    if (!SUPPORTED.has(key)) {
      throw new UnsupportedKeyword(`${path}: unsupported schema keyword "${key}"`);
    }
    if (key === 'properties' || key === '$defs') {
      for (const [name, sub] of Object.entries(value as Schema)) {
        assertKeywordsSupported(sub, `${path}/${key}/${name}`);
      }
    } else if (key === 'items') {
      assertKeywordsSupported(value, `${path}/items`);
    }
  }
}

assertKeywordsSupported(SCHEMA);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  // JSON draws no line between 1 and 1.0, so an integer satisfies number.
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * RFC 3339, checked by range and not only by shape. A digit-count regex alone accepts
 * 2026-13-45T99:99:99Z, which is the kind of value that looks like a timestamp in a
 * diff and denies every call once an enforcement point tries to compare it. Second 60
 * is allowed, because RFC 3339 permits a leap second.
 */
export function isDateTime(value: string): boolean {
  const m = DATE_TIME.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s, , offH, offM] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 60) return false;
  if (offH !== undefined && (Number(offH) > 23 || Number(offM) > 59)) return false;
  return true;
}

function resolveRef(ref: string, root: Schema): Schema {
  const name = ref.replace(/^#\/\$defs\//, '');
  const target = (root.$defs ?? {})[name];
  if (!target) throw new UnsupportedKeyword(`unresolvable $ref ${ref}`);
  return target;
}

function joinPath(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

function check(schema: Schema, value: unknown, path: string, root: Schema, problems: Problem[]): void {
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    check(resolveRef(schema.$ref, root), value, path, root, problems);
    return;
  }

  const where = path || '(root)';

  if ('const' in schema && value !== schema.const) {
    problems.push({ path: where, message: `${JSON.stringify(schema.const)} was expected` });
    return;
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    problems.push({ path: where, message: `${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}` });
    return;
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    problems.push({ path: where, message: `${JSON.stringify(value)} is not of type "${schema.type}"` });
    // Every later keyword assumes the type held, so stop on this branch.
    return;
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push({ path: where, message: `is too short (minimum ${schema.minLength} characters)` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push({ path: where, message: `is too long (maximum ${schema.maxLength} characters)` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      problems.push({ path: where, message: `does not match "${schema.pattern}"` });
    }
    if (schema.format === 'date-time' && !isDateTime(value)) {
      problems.push({ path: where, message: 'is not a valid RFC 3339 date-time' });
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    problems.push({ path: where, message: `is less than the minimum of ${schema.minimum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push({ path: where, message: `has too few items (minimum ${schema.minItems})` });
    }
    if (schema.items) {
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, root, problems));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);

    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      problems.push({ path: where, message: `does not have enough properties (minimum ${schema.minProperties})` });
    }

    for (const name of schema.required ?? []) {
      if (!(name in object)) {
        problems.push({ path: where, message: `"${name}" is a required property` });
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const name of keys) {
        if (!allowed.has(name)) {
          problems.push({ path: joinPath(path, name), message: 'is not a recognized property' });
        }
      }
    }

    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (name in object) check(sub as Schema, object[name], joinPath(path, name), root, problems);
    }
  }
}

/** Collect every problem with an envelope. An empty array means it is well formed. */
export function problems(envelope: unknown): Problem[] {
  const found: Problem[] = [];
  check(SCHEMA as Schema, envelope, '', SCHEMA as Schema, found);
  return found;
}

/** Throw ValidationError unless the envelope satisfies the published schema. */
export function validate(envelope: unknown): void {
  const found = problems(envelope);
  if (found.length) throw new ValidationError(found);
}

export { SCHEMA };
