/**
 * Declared intent envelopes for AI agents.
 *
 * Two halves. `validate` answers whether an envelope is well formed. `evaluate` and
 * `EnforcementPoint` answer the question that matters at runtime: given this envelope,
 * may this call happen, and on whose authority was that decided.
 *
 * Zero runtime dependencies, deliberately. It runs the same conformance cases as the
 * Python implementation, from the same JSON files.
 *
 * Specification: https://securedai.org/agent-intent
 */

export {
  evaluate,
  defaultDataMatcher,
  defaultConditionMatcher,
  UnsupportedCondition,
  type Call,
  type ConditionMatcher,
  type DataMatcher,
  type Decision,
  type DecisionRecord,
  type Envelope,
  type EscalateRule,
  type EvaluateOptions,
  type Limits,
  type Result,
  type RunState,
  type ToolGrant,
} from './evaluate.ts';

export {
  EnforcementPoint,
  Escalated,
  Refused,
  defaultFacts,
  type CheckOverrides,
  type EnforcementOptions,
  type FactsExtractor,
  type ToolFacts,
} from './enforce.ts';

export {
  SCHEMA,
  UnsupportedKeyword,
  ValidationError,
  assertKeywordsSupported,
  isDateTime,
  problems,
  validate,
  type Problem,
} from './validate.ts';

export const VERSION = '0.1.0';
