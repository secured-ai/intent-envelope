/**
 * Decide one proposed tool call against an envelope.
 *
 * This is specification section 3, in its order, and the order is the design rather
 * than an implementation detail. Deny is settled before escalate so a forbidden action
 * is never put in front of a person as something they could approve.
 *
 * It is a port of the Python evaluator and answers every case in `conformance/decisions`
 * identically. That is the whole reason those cases are JSON: two implementations that
 * agree because they run the same files, rather than because someone read both.
 *
 * Nothing here consults the model, the prompt, or the agent's stated reason for the call.
 */

export type Result = 'allow' | 'deny' | 'escalate';

export interface Envelope {
  intent_envelope: string;
  id: string;
  revision?: number;
  purpose: string;
  principal: { agent_identity: string; on_behalf_of?: string };
  tools: { allow: ToolGrant[]; deny?: string[] };
  data?: { allow?: string[]; deny?: string[] };
  recipients?: { allow?: string[]; max_per_run?: number };
  limits: Limits;
  escalate?: EscalateRule[];
  expires?: string;
  on_no_response: 'deny' | 'allow';
  [key: string]: unknown;
}

export interface ToolGrant {
  name: string;
  constraints?: Record<string, unknown>;
}

export interface Limits {
  max_tool_calls?: number;
  max_records?: number;
  max_spend_usd?: number;
  max_runtime_seconds?: number;
}

export interface EscalateRule {
  when: string;
  to: string;
  timeout_seconds?: number;
}

/**
 * One proposed call, as the enforcement point sees it.
 *
 * `context` carries the operands an `escalate.when` expression refers to. It is
 * evidence about the call, never instructions: nothing in it can widen the envelope.
 */
export interface Call {
  tool: string;
  arguments?: Record<string, unknown>;
  data?: string[];
  recipients?: string[];
  estimated_cost_usd?: number;
  context?: Record<string, unknown>;
}

/** What this run has already spent. Limits are arithmetic over this, not judgement. */
export interface RunState {
  now?: string;
  tool_calls_made?: number;
  records_returned?: number;
  spend_usd?: number;
  runtime_seconds?: number;
  recipients_contacted?: number;
}

export interface Decision {
  result: Result;
  rule: string;
  detail: string;
  envelope: Envelope;
  call: Call;
  decidedAt: string;
  escalateTo?: string;
  timeoutSeconds?: number;
  /** The record specification section 5 asks for, written where the decision was made. */
  record(): DecisionRecord;
}

export interface DecisionRecord {
  envelope_id?: string;
  revision?: number;
  agent_identity?: string;
  principal?: string;
  tool: string;
  target?: string[] | null;
  result: Result;
  rule: string;
  detail: string;
  cost_usd: number;
  escalated_to?: string | null;
  decided_at: string;
}

export type DataMatcher = (target: string, pattern: string) => boolean;
export type ConditionMatcher = (condition: string, context: Record<string, unknown>) => boolean;

/**
 * Thrown when the default matcher cannot parse an `escalate.when` expression.
 *
 * Refusing is the point. Returning false for an expression nobody understood would
 * silently turn an action that should have paused for a human into one that ran.
 */
export class UnsupportedCondition extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCondition';
  }
}

/**
 * Exact match, or the pattern naming a prefix segment of the target.
 * `ledger:read` matches `ledger:read:current_month`. Version 0.1 leaves addressing to
 * the deployment, so anything richer belongs in a matcher the deployment supplies.
 */
export const defaultDataMatcher: DataMatcher = (target, pattern) =>
  target === pattern || target.startsWith(`${pattern}:`) || target.startsWith(`${pattern}.`);

const COMPARISON = /^\s*([A-Za-z_][\w.]*)\s*(==|!=|>=|<=|>|<)\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?)\s*$/;
const BARE = /^\s*([A-Za-z_][\w.]*)\s*$/;

/**
 * A deliberately small subset: `key`, or `key <op> number|'string'`.
 *
 * An operand the context does not carry is not a match, because the deployment did not
 * report the thing the condition asks about. An expression this cannot parse throws,
 * because guessing at an escalation rule is how an action that should have paused runs.
 */
export const defaultConditionMatcher: ConditionMatcher = (condition, context) => {
  const bare = BARE.exec(condition);
  if (bare) return Boolean(context[bare[1]]);

  const m = COMPARISON.exec(condition);
  if (!m) {
    throw new UnsupportedCondition(
      `cannot parse escalate.when ${JSON.stringify(condition)}. Version 0.1 defines no ` +
        `expression syntax, so supply conditionMatcher for this deployment's own.`,
    );
  }

  const [, key, op, raw] = m;
  if (!(key in context)) return false;
  const actual = context[key];
  const quoted = raw.startsWith("'") || raw.startsWith('"');
  const expected: string | number = quoted ? raw.slice(1, -1) : Number(raw);

  if (op === '==') return actual === expected || String(actual) === String(expected);
  if (op === '!=') return !(actual === expected || String(actual) === String(expected));

  const actualNumber = Number(actual);
  if (Number.isNaN(actualNumber)) return false;
  const bound = expected as number;
  if (op === '>') return actualNumber > bound;
  if (op === '<') return actualNumber < bound;
  if (op === '>=') return actualNumber >= bound;
  return actualNumber <= bound;
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function parseInstant(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function grantFor(envelope: Envelope, tool: string): ToolGrant | undefined {
  return (envelope.tools?.allow ?? []).find((g) => g.name === tool);
}

/**
 * Default constraint semantics, documented rather than inferred. `max_*` bounds above,
 * `min_*` bounds below, anything else must equal exactly. An argument the call omits is
 * unbounded for max/min and a violation for an equality constraint, because an omitted
 * pin is how a constraint gets sidestepped.
 */
function constraintViolation(grant: ToolGrant, args: Record<string, unknown>): string | null {
  for (const [key, expected] of Object.entries(grant.constraints ?? {})) {
    const actual = args[key];
    if (key.startsWith('max_')) {
      const a = asNumber(actual);
      const e = asNumber(expected);
      if (a !== null && e !== null && a > e) return `${key} is ${actual}, above the permitted ${expected}`;
    } else if (key.startsWith('min_')) {
      const a = asNumber(actual);
      const e = asNumber(expected);
      if (a !== null && e !== null && a < e) return `${key} is ${actual}, below the permitted ${expected}`;
    } else if (actual === undefined) {
      return `${key} is pinned to ${JSON.stringify(expected)} and the call did not supply it`;
    } else if (actual !== expected) {
      return `${key} is ${JSON.stringify(actual)}, not the pinned ${JSON.stringify(expected)}`;
    }
  }
  return null;
}

function limitExceeded(limits: Limits, call: Call, state: Required<RunState>): string | null {
  const cost = call.estimated_cost_usd ?? 0;
  if (limits.max_tool_calls !== undefined && state.tool_calls_made + 1 > limits.max_tool_calls) {
    return `this is call ${state.tool_calls_made + 1} of a permitted ${limits.max_tool_calls}`;
  }
  if (limits.max_spend_usd !== undefined && state.spend_usd + cost > limits.max_spend_usd) {
    return `this call would take spend to ${(state.spend_usd + cost).toFixed(2)} of a permitted ${limits.max_spend_usd.toFixed(2)}`;
  }
  if (limits.max_records !== undefined && state.records_returned >= limits.max_records) {
    return `${state.records_returned} records returned, of a permitted ${limits.max_records}`;
  }
  if (limits.max_runtime_seconds !== undefined && state.runtime_seconds > limits.max_runtime_seconds) {
    return `the run has lasted ${state.runtime_seconds}s, of a permitted ${limits.max_runtime_seconds}`;
  }
  return null;
}

export interface EvaluateOptions {
  dataMatcher?: DataMatcher;
  conditionMatcher?: ConditionMatcher;
}

/** Return exactly one of allow, deny or escalate, and the rule that decided it. */
export function evaluate(
  envelope: Envelope,
  call: Call,
  state: RunState = {},
  options: EvaluateOptions = {},
): Decision {
  const dataMatcher = options.dataMatcher ?? defaultDataMatcher;
  const conditionMatcher = options.conditionMatcher ?? defaultConditionMatcher;

  const run: Required<RunState> = {
    now: state.now ?? '',
    tool_calls_made: state.tool_calls_made ?? 0,
    records_returned: state.records_returned ?? 0,
    spend_usd: state.spend_usd ?? 0,
    runtime_seconds: state.runtime_seconds ?? 0,
    recipients_contacted: state.recipients_contacted ?? 0,
  };
  const decidedAt = run.now || new Date().toISOString();

  const verdict = (
    result: Result,
    rule: string,
    detail: string,
    extra: { escalateTo?: string; timeoutSeconds?: number } = {},
  ): Decision => ({
    result,
    rule,
    detail,
    envelope,
    call,
    decidedAt,
    ...extra,
    record(): DecisionRecord {
      const principal = envelope.principal ?? ({} as Envelope['principal']);
      const target = call.recipients?.length ? call.recipients : call.data?.length ? call.data : null;
      return {
        envelope_id: envelope.id,
        revision: envelope.revision,
        agent_identity: principal.agent_identity,
        principal: principal.on_behalf_of,
        tool: call.tool,
        target,
        result,
        rule,
        detail,
        cost_usd: call.estimated_cost_usd ?? 0,
        escalated_to: extra.escalateTo ?? null,
        decided_at: decidedAt,
      };
    },
  });

  // 1. An envelope past its expiry denies everything. The check belongs here, at the
  //    moment of the call, not at the moment the envelope was issued.
  if (envelope.expires) {
    const deadline = parseInstant(envelope.expires);
    if (deadline === null) {
      return verdict('deny', 'expires', `expires is ${JSON.stringify(envelope.expires)}, which is not an instant this can compare`);
    }
    const now = run.now ? parseInstant(run.now) : Date.now();
    if (now !== null && now >= deadline) {
      return verdict('deny', 'expires', `the envelope expired at ${envelope.expires}`);
    }
  }

  // 2. Deny always wins, before anything consults the allow list.
  if ((envelope.tools?.deny ?? []).includes(call.tool)) {
    return verdict('deny', 'tools.deny', `${call.tool} is on tools.deny, which no later grant overrides`);
  }

  // 3. Silence is not permission.
  const grant = grantFor(envelope, call.tool);
  if (!grant) return verdict('deny', 'tools.allow', `${call.tool} is not on tools.allow`);

  // 4. The tool is granted. The arguments still have to be the ones that were granted.
  const violation = constraintViolation(grant, call.arguments ?? {});
  if (violation) return verdict('deny', 'tools.constraints', violation);

  // 5. Data. An absent data block is unconstrained here, unlike recipients, because
  //    0.1 states the default for recipients and not for this one.
  if (envelope.data) {
    for (const target of call.data ?? []) {
      for (const pattern of envelope.data.deny ?? []) {
        if (dataMatcher(target, pattern)) {
          return verdict('deny', 'data', `${target} matches data.deny entry ${pattern}`);
        }
      }
      const allowed = envelope.data.allow;
      if (allowed !== undefined && !allowed.some((p) => dataMatcher(target, p))) {
        return verdict('deny', 'data', `${target} is not within data.allow`);
      }
    }
  }

  // 6. Recipients. An absent block means nobody, which the specification states.
  const recipients = call.recipients ?? [];
  if (recipients.length) {
    if (!envelope.recipients) {
      return verdict('deny', 'recipients', 'the envelope names no recipients, which permits contacting nobody');
    }
    const permitted = envelope.recipients.allow ?? [];
    for (const who of recipients) {
      if (!permitted.some((p) => who === p || who.endsWith(p))) {
        return verdict('deny', 'recipients', `${who} is not on recipients.allow`);
      }
    }
    const maxPerRun = envelope.recipients.max_per_run;
    if (maxPerRun !== undefined && run.recipients_contacted + recipients.length > maxPerRun) {
      const total = run.recipients_contacted + recipients.length;
      return verdict('deny', 'recipients', `this call would contact ${total} of a permitted ${maxPerRun}`);
    }
  }

  // 7. Budgets are arithmetic, which is why they hold when judgement does not.
  const exceeded = limitExceeded(envelope.limits ?? {}, call, run);
  if (exceeded) return verdict('deny', 'limits', exceeded);

  // 8. Only now, with the call established as permitted, may a human be asked.
  for (const rule of envelope.escalate ?? []) {
    if (rule.when && conditionMatcher(rule.when, call.context ?? {})) {
      return verdict('escalate', 'escalate', `${rule.when} matched`, {
        escalateTo: rule.to,
        timeoutSeconds: rule.timeout_seconds,
      });
    }
  }

  // 9. Nothing fired.
  return verdict('allow', 'allow', 'inside the envelope');
}
