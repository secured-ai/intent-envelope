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
 *
 * Version 0.2 adds four rules, each of which applies only when the envelope carries
 * the block it reads, so every 0.1 envelope decides exactly as it did: amendment
 * (tools that change envelopes are denied to the governed agent), credentials (a
 * credential must be bound to this run and expire with the envelope), data.processors
 * (which inference providers a prompt may reach) and egress (which hosts a tool may
 * reach).
 */

export type Result = 'allow' | 'deny' | 'escalate';

export interface Envelope {
  intent_envelope: string;
  id: string;
  revision?: number;
  purpose: string;
  principal: { agent_identity: string; on_behalf_of?: string };
  tools: { allow: ToolGrant[]; deny?: string[] };
  data?: { allow?: string[]; deny?: string[]; processors?: string[] };
  /** 0.2. Hosts a tool may reach. Deny wins. */
  egress?: { allow?: string[]; deny?: string[] };
  /** 0.2. What a credential the agent uses must be bound to, and how long it may live. */
  credentials?: { bind: 'run' | 'task'; max_lifetime_seconds?: number };
  /** 0.2. Who may change this envelope, and which tools change it. */
  amendment?: { approvers?: Array<{ id: string; public_key: string }>; protected_tools?: string[] };
  /** 0.2. Admission of MCP servers, skills and plugins. */
  components?: { require_manifest?: boolean };
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
  /** 0.2. Hosts the call would reach, as the enforcement point established them. */
  egress?: string[];
  /** 0.2. Inference providers or subprocessors the call would send data to. */
  processors?: string[];
  /** 0.2. The credential the call would use, as its issuer describes it. */
  credential?: CredentialFacts;
}

export interface CredentialFacts {
  run_id?: string;
  task_id?: string;
  issued_at?: string;
  expires_at?: string;
}

/** What this run has already spent. Limits are arithmetic over this, not judgement. */
export interface RunState {
  now?: string;
  tool_calls_made?: number;
  records_returned?: number;
  spend_usd?: number;
  runtime_seconds?: number;
  recipients_contacted?: number;
  /** 0.2. Which run, and which task within it, a credential must be bound to. */
  run_id?: string;
  task_id?: string;
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

function ipv4(value: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * 0.2 host matching, the same in every implementation: an exact host or IP, a leading
 * dot or "*." for any subdomain (never the bare domain itself), or an IPv4 CIDR range.
 * Case-insensitive, and a trailing dot is ignored, because "Metadata.Google.Internal."
 * is the same host.
 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase().replace(/\.$/, '');
  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(p);
  if (cidr) {
    const base = ipv4(cidr[1]);
    const addr = ipv4(h);
    const bits = Number(cidr[2]);
    if (base === null || addr === null || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
  }
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  if (p.startsWith('.')) return h.endsWith(p);
  return h === p;
}

/** Why a credential does not satisfy the envelope's credentials block, or null. */
function credentialViolation(envelope: Envelope, call: Call, run: Required<RunState>): string | null {
  const rule = envelope.credentials;
  if (!rule) return null;
  const c = call.credential;
  if (!c) return 'the call carries no credential facts, so what it is bound to cannot be established';
  if (!c.run_id || !run.run_id || c.run_id !== run.run_id) {
    return `the credential is bound to ${c.run_id ? `run ${c.run_id}` : 'no run'}, not this run${run.run_id ? ` (${run.run_id})` : ''}`;
  }
  if (rule.bind === 'task' && (!c.task_id || !run.task_id || c.task_id !== run.task_id)) {
    return `the credential is bound to ${c.task_id ? `task ${c.task_id}` : 'no task'}, not this task${run.task_id ? ` (${run.task_id})` : ''}`;
  }
  const expires = parseInstant(c.expires_at);
  if (expires === null) return 'the credential states no expiry, so it could outlive the envelope';
  const ends = parseInstant(envelope.expires);
  if (ends !== null && expires > ends) return `the credential expires at ${c.expires_at}, after the envelope does`;
  if (rule.max_lifetime_seconds !== undefined) {
    const issued = parseInstant(c.issued_at);
    if (issued === null) return 'the credential states no issue time, so its lifetime cannot be checked';
    const lifetime = Math.round((expires - issued) / 1000);
    if (lifetime > rule.max_lifetime_seconds) {
      return `the credential lives ${lifetime}s, longer than the permitted ${rule.max_lifetime_seconds}s`;
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
    run_id: state.run_id ?? '',
    task_id: state.task_id ?? '',
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

  // 0.2: a tool that changes envelopes, policies or controls is denied to the agent
  //    the envelope governs, whatever tools.allow says. Spec section 2.1 requirement 1:
  //    an agent that can widen its own envelope is asking permission from itself.
  if ((envelope.amendment?.protected_tools ?? []).includes(call.tool)) {
    return verdict('deny', 'amendment', `${call.tool} changes envelopes or controls, which the agent they govern may never do`);
  }

  // 3. Silence is not permission.
  const grant = grantFor(envelope, call.tool);
  if (!grant) return verdict('deny', 'tools.allow', `${call.tool} is not on tools.allow`);

  // 4. The tool is granted. The arguments still have to be the ones that were granted.
  const violation = constraintViolation(grant, call.arguments ?? {});
  if (violation) return verdict('deny', 'tools.constraints', violation);

  // 0.2: a credential bound to this run, that dies with the envelope.
  const badCredential = credentialViolation(envelope, call, run);
  if (badCredential) return verdict('deny', 'credentials', badCredential);

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

  // 0.2: where the data goes to be processed. Present and empty means nowhere.
  const processors = envelope.data?.processors;
  if (processors !== undefined) {
    for (const p of call.processors ?? []) {
      if (!processors.includes(p)) return verdict('deny', 'data.processors', `${p} is not on data.processors`);
    }
  }

  // 0.2: which hosts the call reaches. Deny wins, as everywhere else.
  if (envelope.egress) {
    for (const host of call.egress ?? []) {
      const denied = (envelope.egress.deny ?? []).find((p) => hostMatches(host, p));
      if (denied) return verdict('deny', 'egress', `${host} matches egress.deny entry ${denied}`);
      const allowed = envelope.egress.allow;
      if (allowed !== undefined && !allowed.some((p) => hostMatches(host, p))) {
        return verdict('deny', 'egress', `${host} is not on egress.allow`);
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
