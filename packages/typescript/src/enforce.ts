/**
 * The enforcement point: an envelope, the run so far, and a wrapper for a tool call.
 *
 * `evaluate` decides one call in isolation. Something has to hold the run together, or
 * limits mean nothing: `max_tool_calls` is only a limit if somebody counts, and the
 * agent counting its own calls is the arrangement this specification exists to replace.
 *
 * `guard` wraps an existing tool-call function so a deployment adds enforcement without
 * restructuring its agent. MCP first, because one integration covers every tool a
 * server exposes.
 *
 * Nothing here can be switched off by the thing it governs. There is no argument an
 * agent can pass that widens the envelope.
 */

import {
  type Call,
  type ConditionMatcher,
  type DataMatcher,
  type Decision,
  type DecisionRecord,
  type Envelope,
  type Result,
  type RunState,
  evaluate,
} from './evaluate.ts';

/** Thrown when a guarded call is denied. Carries the decision and its record. */
export class Refused extends Error {
  readonly decision: Decision;
  constructor(decision: Decision) {
    super(`${decision.rule}: ${decision.detail}`);
    this.name = 'Refused';
    this.decision = decision;
  }
}

/**
 * Thrown when a guarded call needs a named human before it can run.
 *
 * Separate from Refused on purpose. A deployment that treats them alike has collapsed
 * "a person must decide this" into "no", which loses the point of an escalation path.
 */
export class Escalated extends Error {
  readonly decision: Decision;
  constructor(decision: Decision) {
    super(`needs ${decision.escalateTo}: ${decision.detail}`);
    this.name = 'Escalated';
    this.decision = decision;
  }
}

/**
 * What a call touches, in the terms the envelope is written in. MCP carries a tool name
 * and arguments and nothing else, so somebody has to say which argument is a recipient
 * and which is a data target. That mapping is deployment knowledge, not protocol.
 */
export interface ToolFacts {
  data: string[];
  recipients: string[];
  estimated_cost_usd: number;
  context: Record<string, unknown>;
}

export type FactsExtractor = (tool: string, args: Record<string, unknown>) => ToolFacts;

const RECIPIENT_KEYS = ['to', 'recipient', 'recipients', 'to_address', 'email', 'send_to', 'channel'];
const DATA_KEYS = ['data', 'dataset', 'collection', 'collections', 'resource', 'resources', 'scope'];

/**
 * Read conventional argument names. Documented, small, and easy to outgrow.
 *
 * The failure mode worth knowing: a recipient this does not recognise is a recipient
 * the envelope never checks, so a tool that can send should have its extractor written
 * rather than inherited.
 */
export const defaultFacts: FactsExtractor = (_tool, args) => {
  const collect = (keys: string[]): string[] => {
    const found: string[] = [];
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string') found.push(value);
      else if (Array.isArray(value)) found.push(...value.map(String));
    }
    return found;
  };

  const context: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (['string', 'number', 'boolean'].includes(typeof v)) context[k] = v;
  }

  return { data: collect(DATA_KEYS), recipients: collect(RECIPIENT_KEYS), estimated_cost_usd: 0, context };
};

export interface EnforcementOptions {
  facts?: FactsExtractor;
  onDecision?: (decision: Decision) => void;
  dataMatcher?: DataMatcher;
  conditionMatcher?: ConditionMatcher;
  now?: () => string;
}

export interface CheckOverrides {
  data?: string[];
  recipients?: string[];
  estimated_cost_usd?: number;
  context?: Record<string, unknown>;
}

type ToolCaller = (name: string, args?: Record<string, unknown>, ...rest: unknown[]) => unknown;

/** Holds one envelope and one run, and decides every call in it. */
export class EnforcementPoint {
  readonly state: Required<RunState>;
  readonly decisions: Decision[] = [];

  readonly envelope: Envelope;
  private readonly options: EnforcementOptions;

  constructor(envelope: Envelope, options: EnforcementOptions = {}) {
    this.envelope = envelope;
    this.options = options;
    this.state = {
      now: '',
      tool_calls_made: 0,
      records_returned: 0,
      spend_usd: 0,
      runtime_seconds: 0,
      recipients_contacted: 0,
    };
  }

  /** Decide a call without running it. Records the decision either way. */
  check(tool: string, args: Record<string, unknown> = {}, overrides: CheckOverrides = {}): Decision {
    const extract = this.options.facts ?? defaultFacts;
    const found = extract(tool, args);

    const call: Call = {
      tool,
      arguments: args,
      data: overrides.data ?? found.data,
      recipients: overrides.recipients ?? found.recipients,
      estimated_cost_usd: overrides.estimated_cost_usd ?? found.estimated_cost_usd,
      context: { ...found.context, ...(overrides.context ?? {}) },
    };

    if (this.options.now) this.state.now = this.options.now();

    const decision = evaluate(this.envelope, call, this.state, {
      dataMatcher: this.options.dataMatcher,
      conditionMatcher: this.options.conditionMatcher,
    });

    // Every outcome is recorded, refused as well as allowed. A ledger holding only what
    // succeeded cannot answer the question an incident actually asks.
    this.decisions.push(decision);
    this.options.onDecision?.(decision);

    // Only a call that is going to happen spends the run's budget. Counting refused
    // calls would let a blocked agent exhaust its own allowance by being blocked.
    if (decision.result === 'allow') {
      this.state.tool_calls_made += 1;
      this.state.spend_usd += call.estimated_cost_usd ?? 0;
      this.state.recipients_contacted += call.recipients?.length ?? 0;
    }
    return decision;
  }

  /** Decide, and throw unless the answer is allow. */
  enforce(tool: string, args: Record<string, unknown> = {}, overrides: CheckOverrides = {}): Decision {
    const decision = this.check(tool, args, overrides);
    if (decision.result === 'deny') throw new Refused(decision);
    if (decision.result === 'escalate') throw new Escalated(decision);
    return decision;
  }

  /**
   * Wrap a tool-call function so every call through it is checked first.
   *
   * Works with an MCP client's `callTool(name, args)` as it stands. The check happens
   * before the call, because a decision made afterwards is a report rather than a control.
   */
  guard<F extends ToolCaller>(callTool: F): F {
    const point = this;
    const guarded = function (name: string, args: Record<string, unknown> = {}, ...rest: unknown[]) {
      point.enforce(name, args);
      return callTool(name, args, ...rest);
    };
    Object.defineProperty(guarded, 'enforcementPoint', { value: this, enumerable: false });
    return guarded as F;
  }

  /** Every decision this run made, in order, as section 5 records. */
  ledger(): DecisionRecord[] {
    return this.decisions.map((d) => d.record());
  }

  summary(): Record<Result, number> {
    const counts: Record<Result, number> = { allow: 0, deny: 0, escalate: 0 };
    for (const d of this.decisions) counts[d.result] += 1;
    return counts;
  }
}
