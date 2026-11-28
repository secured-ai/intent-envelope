/**
 * An enforcement point that sits in the MCP wire protocol itself.
 *
 * The client launches this instead of the server it wants. Every tool call crosses this
 * process, is decided against the envelope, and is forwarded only if the envelope
 * permits it. A refused call is never written to the upstream server's stdin, which is
 * the only property that matters: a decision made after the call has already run is a
 * report, not an enforcement point.
 *
 * Why a line relay rather than the MCP SDK
 * ----------------------------------------
 * This understands exactly two methods, `tools/call` and `tools/list`, and relays
 * every other line byte for byte. That is deliberate. The protocol has two eras in
 * circulation, one using `server/discover` with inline `_meta` and one using the
 * `initialize` handshake, and it keeps growing: `subscriptions/listen`,
 * `notifications/cancelled`, `InputRequiredResult`. A proxy that modelled the whole
 * protocol would need to track all of it and would break on the next addition. A relay
 * that forwards what it does not recognise works across both eras and survives
 * additions it has never heard of.
 *
 * It also means an unparseable line is passed along untouched rather than dropped. This
 * process is not the arbiter of protocol validity; it is the arbiter of one question,
 * which is whether a tool call is inside the envelope.
 *
 * stdout discipline
 * -----------------
 * The transport requires that nothing but valid MCP messages reach stdout. Every log,
 * warning and summary this process emits goes to stderr, which the specification
 * explicitly permits and tells clients not to treat as failure.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EnforcementPoint, type Decision, type Envelope } from 'intent-envelope';
import type { ComponentManifest } from './config.ts';

import type { Ledger } from './ledger.ts';

/**
 * Where an escalated call goes to wait for a person.
 *
 * Without one, an escalation is refused with the name of who must approve it, which is
 * what this proxy has always done. With one, the call is held, neither forwarded nor
 * answered, until the handler resolves. The handler must resolve to deny on every
 * failure: a handler that throws is treated as a deny here as well.
 */
export interface EscalationHandler {
  resolve(
    call: { tool: string; arguments: Record<string, unknown> },
    decision: Decision,
    signal: AbortSignal,
  ): Promise<EscalationAnswer>;
  /** Shown on startup, so the operator can see where escalations go. */
  describe?(): string;
}

export interface EscalationAnswer {
  outcome: 'allow' | 'deny';
  /** Why, in words. Goes into the ledger and, on a deny, the error the client sees. */
  reason: string;
  /** True only when the answer came from something this process verified, such as a signed record. */
  verified: boolean;
  /** Who answered, when a person did. */
  decided_by?: string;
  approval_id?: string;
}

/** Implementation-defined JSON-RPC server error codes, per the JSON-RPC 2.0 spec. */
export const DENIED = -32000;
export const ESCALATION_REQUIRED = -32001;

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; [key: string]: unknown };
  result?: { tools?: Array<{ name?: string }>; [key: string]: unknown };
  error?: unknown;
}

export interface RelayOptions {
  envelope: Envelope;
  ledger: Ledger;
  upstream: ChildProcessWithoutNullStreams;
  /** The client's side: what this process reads requests from and writes replies to. */
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (message: string) => void;
  /** Hide tools the envelope does not allow from tools/list. Defence in depth only. */
  filterToolList?: boolean;
  /** Hold escalated calls until this answers. Absent: escalations are refused. */
  escalations?: EscalationHandler;
  /**
   * 0.2. The admitted manifest. A tool the server exposes but the manifest never
   * declared is hidden from tools/list and refused on tools/call: a component that grew
   * a tool after admission does not get to use it.
   */
  component?: ComponentManifest;
}

/**
 * Split a byte stream into the transport's newline-delimited messages.
 *
 * Messages must not contain embedded newlines, so a line is a message. A trailing
 * fragment is held until its newline arrives rather than being guessed at.
 */
function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, onEnd: () => void): void {
  let buffer = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer);
    onEnd();
  });
}

function parse(line: string): Rpc | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Rpc) : undefined;
  } catch {
    return undefined;
  }
}

/** Every tool name the envelope grants, for the optional tools/list filter. */
function allowedNames(envelope: Envelope): Set<string> {
  return new Set((envelope.tools?.allow ?? []).map((grant) => grant.name));
}

/** A refusal for a tool the admitted component never declared. */
function undeclared(envelope: Envelope, tool: string, args: Record<string, unknown>, component: string): Decision {
  const decidedAt = new Date().toISOString();
  const detail = `${tool} is not declared in the manifest of ${component}, which is what was admitted`;
  const principal = envelope.principal ?? ({} as Envelope['principal']);
  return {
    result: 'deny', rule: 'components', detail, envelope, call: { tool, arguments: args }, decidedAt,
    record: () => ({
      envelope_id: envelope.id, revision: envelope.revision, agent_identity: principal.agent_identity,
      principal: principal.on_behalf_of, tool, target: null, result: 'deny', rule: 'components', detail,
      cost_usd: 0, escalated_to: null, decided_at: decidedAt,
    }),
  };
}

/** The ledger entry for how an escalation ended, beside the entry that raised it. */
function settled(decision: Decision, result: 'allow' | 'deny', answer: EscalationAnswer): Decision {
  return {
    ...decision,
    result,
    rule: 'escalate',
    detail: answer.reason,
    decidedAt: new Date().toISOString(),
    record() {
      return {
        ...decision.record(),
        result,
        rule: 'escalate',
        detail: answer.reason,
        decided_at: this.decidedAt,
        approval: {
          verified: answer.verified,
          ...(answer.approval_id ? { id: answer.approval_id } : {}),
          ...(answer.decided_by ? { decided_by: answer.decided_by } : {}),
        },
      } as ReturnType<Decision['record']>;
    },
  };
}

export class Relay {
  private readonly point: EnforcementPoint;
  private readonly options: RelayOptions;
  private readonly allowed: Set<string>;
  private readonly declared: Set<string> | null;
  /** ids of tools/list requests in flight, so their replies can be filtered. */
  private readonly listRequests = new Set<string>();
  private closed = false;
  /** Escalated calls being held, by request id, so a cancellation can withdraw them. */
  private readonly held = new Map<string, AbortController>();

  constructor(options: RelayOptions) {
    this.options = options;
    this.allowed = allowedNames(options.envelope);
    this.declared = options.component ? new Set(options.component.tools) : null;
    if (options.component) this.log(`component ${options.component.name} admitted with ${options.component.tools.length} declared tools`);
    this.point = new EnforcementPoint(options.envelope, {
      onDecision: (decision) => options.ledger.record(decision),
    });

    // An operator who wrote on_no_response: allow asked for calls to proceed when a
    // human does not answer in time. This process does not wait for a human at all, so
    // honouring that would let a call through that nobody ever saw. It refuses instead,
    // and says so, rather than being quietly stricter than the envelope asked.
    if (options.escalations) {
      this.log(`escalations wait for an answer from ${options.escalations.describe?.() ?? 'the configured approval channel'}`);
    } else if (options.envelope.on_no_response === 'allow') {
      this.log(
        'warning: this envelope sets on_no_response: allow, but no approval channel is ' +
          'configured, so escalated calls are refused rather than allowed.',
      );
    }
  }

  private log(message: string): void {
    (this.options.log ?? ((m: string) => process.stderr.write(`[intent-envelope] ${m}\n`)))(message);
  }

  private send(message: unknown): void {
    // One message per line, and nothing else on this stream, ever.
    this.options.output.write(`${JSON.stringify(message)}\n`);
  }

  private toUpstream(line: string): void {
    if (!this.closed) this.options.upstream.stdin.write(`${line}\n`);
  }

  private refuse(id: string | number | null, decision: Decision): void {
    const escalating = decision.result === 'escalate';
    this.send({
      jsonrpc: '2.0',
      id,
      error: {
        code: escalating ? ESCALATION_REQUIRED : DENIED,
        message: escalating
          ? `intent envelope: this call needs ${decision.escalateTo}: ${decision.detail}`
          : `intent envelope: refused by ${decision.rule}: ${decision.detail}`,
        // The decision record travels with the refusal so a client can log the same
        // thing the ledger holds, rather than re-deriving it from prose.
        data: { intent_envelope: decision.record() },
      },
    });
  }

  /** Returns true when the line was handled here and must not reach the upstream. */
  private interceptFromClient(line: string, message: Rpc): boolean {
    if (message.method === 'notifications/cancelled') {
      // Relayed as well: the upstream may have its own requests in flight under that id.
      this.cancelled(message);
      return false;
    }

    if (message.method === 'tools/list' && message.id !== undefined && message.id !== null) {
      this.listRequests.add(String(message.id));
      return false;
    }

    if (message.method !== 'tools/call') return false;

    const tool = typeof message.params?.name === 'string' ? message.params.name : '';
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;

    // 0.2: a tool the admitted manifest never declared is refused before the envelope
    // is consulted. The envelope may well grant it; this server was not admitted to
    // provide it.
    if (this.declared && !this.declared.has(tool)) {
      const refused = undeclared(this.options.envelope, tool, args, this.options.component!.name);
      this.options.ledger.record(refused);
      if (message.id === undefined || message.id === null) return true;
      this.refuse(message.id, refused);
      return true;
    }

    // No argument an agent passes can widen the envelope. The envelope was read from
    // disk before this process accepted a single message and is never re-read.
    const decision = this.point.check(tool, args);

    if (decision.result === 'allow') return false;

    if (
      decision.result === 'escalate' &&
      this.options.escalations &&
      message.id !== undefined &&
      message.id !== null
    ) {
      this.hold(line, message.id, tool, args, decision);
      return true;
    }

    if (message.id === undefined || message.id === null) {
      // A tools/call without an id is not answerable. It is still recorded, and it is
      // still not forwarded, which is the part that matters.
      this.log(`refused an unanswerable ${tool} call: ${decision.rule}`);
      return true;
    }

    this.refuse(message.id, decision);
    return true;
  }

  /**
   * Keep an escalated call off the upstream's stdin until someone answers it.
   *
   * The original line is what gets forwarded on an allow, byte for byte, so what the
   * approver saw and what the server runs are the same call. Other messages keep flowing
   * while it waits: one held call does not stall the session.
   */
  private hold(line: string, id: string | number, tool: string, args: Record<string, unknown>, decision: Decision): void {
    const key = String(id);
    const controller = new AbortController();
    this.held.set(key, controller);

    const settle = (answer: EscalationAnswer) => {
      this.held.delete(key);
      const approved = answer.outcome === 'allow' && answer.verified;
      this.options.ledger.record(settled(decision, approved ? 'allow' : 'deny', answer));
      // The client cancelled. MCP says not to answer a cancelled request, and the call
      // is not forwarded either way.
      if (controller.signal.aborted) return;
      if (approved) {
        // The run budget is spent by a call that is going to happen, as for any allow.
        const state = this.point.state;
        state.tool_calls_made += 1;
        state.spend_usd += decision.call.estimated_cost_usd ?? 0;
        state.recipients_contacted += decision.call.recipients?.length ?? 0;
        this.toUpstream(line);
        return;
      }
      this.send({
        jsonrpc: '2.0',
        id,
        error: {
          code: DENIED,
          message: `intent envelope: escalated to ${decision.escalateTo}, and not approved: ${answer.reason}`,
          data: { intent_envelope: settled(decision, 'deny', answer).record() },
        },
      });
    };

    Promise.resolve()
      .then(() => this.options.escalations!.resolve({ tool, arguments: args }, decision, controller.signal))
      .then(settle, (error: unknown) =>
        settle({
          outcome: 'deny',
          verified: false,
          reason: `the approval channel failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
  }

  /** A notifications/cancelled for a held call withdraws it. */
  private cancelled(message: Rpc): void {
    const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
    if (requestId === undefined || requestId === null) return;
    this.held.get(String(requestId))?.abort();
  }

  /** Filter a tools/list reply down to what the envelope grants. */
  private interceptFromUpstream(line: string, message: Rpc): string {
    const id = message.id === undefined || message.id === null ? '' : String(message.id);
    if (!id || !this.listRequests.has(id)) return line;
    this.listRequests.delete(id);

    if (this.options.filterToolList === false) return line;
    const tools = message.result?.tools;
    if (!Array.isArray(tools)) return line;

    const kept = tools.filter((tool) => typeof tool?.name === 'string' && this.allowed.has(tool.name)
      && (!this.declared || this.declared.has(tool.name)));
    const undeclaredTools = this.declared
      ? tools.filter((t) => typeof t?.name === 'string' && !this.declared!.has(t.name)).map((t) => t.name)
      : [];
    if (undeclaredTools.length) {
      this.log(`warning: the server exposes tools its manifest does not declare, hidden and refused: ${undeclaredTools.join(', ')}`);
    }
    if (kept.length !== tools.length) {
      this.log(`tools/list: offering ${kept.length} of ${tools.length} tools the server exposes`);
    }
    return JSON.stringify({ ...message, result: { ...message.result, tools: kept } });
  }

  start(): void {
    const { upstream, input, output } = this.options;

    lines(
      input,
      (line) => {
        const message = parse(line);
        // An unparseable line is the client's business, not this process's. Relay it.
        if (!message || !this.interceptFromClient(line, message)) this.toUpstream(line);
      },
      () => {
        // Closing the upstream's stdin is the portable graceful shutdown signal. Anything
        // still waiting for approval is withdrawn: nobody is left to answer.
        for (const controller of this.held.values()) controller.abort();
        this.closed = true;
        upstream.stdin.end();
      },
    );

    lines(
      upstream.stdout,
      (line) => {
        const message = parse(line);
        output.write(`${message ? this.interceptFromUpstream(line, message) : line}\n`);
      },
      () => {},
    );

    // The specification tells clients not to read failure into a server's stderr, so
    // the upstream's logging is passed along rather than swallowed or reinterpreted.
    upstream.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  }

  summary(): Record<string, number> {
    return this.point.summary();
  }
}
