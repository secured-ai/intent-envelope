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

import type { Ledger } from './ledger.ts';

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

export class Relay {
  private readonly point: EnforcementPoint;
  private readonly options: RelayOptions;
  private readonly allowed: Set<string>;
  /** ids of tools/list requests in flight, so their replies can be filtered. */
  private readonly listRequests = new Set<string>();
  private closed = false;

  constructor(options: RelayOptions) {
    this.options = options;
    this.allowed = allowedNames(options.envelope);
    this.point = new EnforcementPoint(options.envelope, {
      onDecision: (decision) => options.ledger.record(decision),
    });

    // An operator who wrote on_no_response: allow asked for calls to proceed when a
    // human does not answer in time. This process does not wait for a human at all, so
    // honouring that would let a call through that nobody ever saw. It refuses instead,
    // and says so, rather than being quietly stricter than the envelope asked.
    if (options.envelope.on_no_response === 'allow') {
      this.log(
        'warning: this envelope sets on_no_response: allow, but this proxy does not ' +
          'wait for a human, so escalated calls are refused rather than allowed.',
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
    if (message.method === 'tools/list' && message.id !== undefined && message.id !== null) {
      this.listRequests.add(String(message.id));
      return false;
    }

    if (message.method !== 'tools/call') return false;

    const tool = typeof message.params?.name === 'string' ? message.params.name : '';
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;

    // No argument an agent passes can widen the envelope. The envelope was read from
    // disk before this process accepted a single message and is never re-read.
    const decision = this.point.check(tool, args);

    if (decision.result === 'allow') return false;

    if (message.id === undefined || message.id === null) {
      // A tools/call without an id is not answerable. It is still recorded, and it is
      // still not forwarded, which is the part that matters.
      this.log(`refused an unanswerable ${tool} call: ${decision.rule}`);
      return true;
    }

    this.refuse(message.id, decision);
    return true;
  }

  /** Filter a tools/list reply down to what the envelope grants. */
  private interceptFromUpstream(line: string, message: Rpc): string {
    const id = message.id === undefined || message.id === null ? '' : String(message.id);
    if (!id || !this.listRequests.has(id)) return line;
    this.listRequests.delete(id);

    if (this.options.filterToolList === false) return line;
    const tools = message.result?.tools;
    if (!Array.isArray(tools)) return line;

    const kept = tools.filter((tool) => typeof tool?.name === 'string' && this.allowed.has(tool.name));
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
        // Closing the upstream's stdin is the portable graceful shutdown signal.
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
