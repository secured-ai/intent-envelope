# intent-envelope-mcp

Enforce an intent envelope on an MCP server. A tool call outside the envelope is refused
before it reaches the server.

Your MCP client launches this instead of the server it wants. Every tool call crosses
this process, is decided against the envelope, and is forwarded only if the envelope
permits it. Nothing about the client changes, and no code in your agent changes.

```
your agent  ──►  intent-envelope-mcp  ──►  the MCP server
                 (decides, then forwards or refuses)
```

Implements [Intent Envelope 0.1](../../spec/v0.1.md). Apache-2.0.

## Why a separate process

The component that decides what an agent may do is not the component an attacker is
talking to. An agent can be argued into anything; it cannot argue with a process that
does not read its reasoning. The envelope is read from disk before the first message is
accepted and is never re-read, so there is no tool call, argument, document or
notification that changes what is permitted.

## Install

```sh
npm install -g intent-envelope-mcp
```

Requires Node 22.18 or newer. The only dependency is
[`intent-envelope`](../typescript) itself.

## Use

```sh
intent-envelope-mcp --envelope ./ap-agent.json -- npx -y @acme/invoice-mcp
```

Everything after `--` is the server to govern. In a client config, wrap what you already
had:

```json
{
  "mcpServers": {
    "invoices": {
      "command": "intent-envelope-mcp",
      "args": [
        "--envelope", "/etc/intent-envelopes/ap-agent.json",
        "--ledger", "/var/log/ap-agent-decisions.jsonl",
        "--", "npx", "-y", "@acme/invoice-mcp"
      ]
    }
  }
}
```

| Option | Meaning |
| --- | --- |
| `--envelope <path>` | the envelope to enforce, or `INTENT_ENVELOPE` |
| `--ledger <path>` | append decisions as JSON lines, or `INTENT_ENVELOPE_LEDGER` |
| `--no-filter-tools` | advertise every upstream tool, refusing the ones not granted |

An envelope that fails validation stops the process with exit code 2 before it accepts a
message. An enforcement point that starts with an envelope it cannot understand is worse
than one that does not start, because the client assumes it is running.

## What a refusal looks like

A refused call returns a JSON-RPC error rather than a tool result. The tool never ran, so
reporting it as a result that failed would be a lie the agent then reasons from.

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": {
    "code": -32000,
    "message": "intent envelope: refused by tools.deny: issue_payment is on tools.deny, which no later grant overrides",
    "data": {
      "intent_envelope": {
        "envelope_id": "invoice-reconciler",
        "revision": 3,
        "agent_identity": "invoice-reconciler",
        "tool": "issue_payment",
        "result": "deny",
        "rule": "tools.deny",
        "decided_at": "2026-11-03T16:09:44.812Z"
      }
    }
  }
}
```

Two codes, because collapsing them would turn "a named person must decide this" into
"no":

| Code | Meaning |
| --- | --- |
| `-32000` | refused by the envelope |
| `-32001` | a named human must approve this call |

## The ledger

With `--ledger`, every decision is appended as one JSON object per line, flushed as it is
made. Refusals are recorded, not only successes: a log holding what succeeded cannot
answer the question an incident asks, which is what the agent tried to do.

Each record names the envelope, its revision, the agent identity, the tool, the result,
the rule that decided and when, which is enough to reconstruct a run months later against
the exact envelope revision in force at the time.

If the ledger cannot be written, enforcement continues and the failure is reported once
on stderr. Refusing correctly while unable to log is degraded; allowing calls because a
disk filled up would be a breach.

## See it work

```sh
node demo/poisoned-invoice.mjs
```

An agent reads a supplier invoice containing instructions, believes every word, and
carries them out in order. Nothing detects the injection, no prompt asks the model to be
careful, and there is no classifier. The exfiltration and the payment are refused anyway.
The invoice server's own stderr shows it ran only the two calls the envelope permitted.

The document also tells the agent not to involve a human. That instruction has nothing to
enforce it, so the mismatch escalates regardless.

## What this does not do

Worth being explicit, because a guardrail people misunderstand is worse than none.

- **It does not wait for a human.** An escalation is recorded as an escalation and the
  call is refused with the name of who must approve it. There is no approval channel yet,
  so `on_no_response: allow` is **not** honoured: escalated calls are refused rather than
  allowed, and the process says so on startup if your envelope sets it. Being stricter
  than the envelope asked is the safe direction, but it is a difference and you should
  know about it.
- **Tool filtering is not the gate.** `tools/list` is filtered to what the envelope
  grants, which reduces what the model is tempted by, but a client can call any name it
  likes. The guarantee comes from intercepting `tools/call`, which happens whether or not
  the tool was ever advertised. `--no-filter-tools` turns the cosmetic half off and
  changes nothing about enforcement.
- **It governs one server.** Run one of these per server you want governed, which is how
  MCP client configs are shaped anyway. Calls that reach a server by some other route are
  not governed by it, so the envelope is only as good as the chokepoint you put it in.
- **It does not inspect prompts or model output.** It decides tool calls. An agent talked
  into something that stays inside its envelope is not something this notices.
- **`max_runtime_seconds` is not enforced**, because this process does not own your run
  loop and cannot tell a slow tool from a long think.

## Why a line relay rather than the MCP SDK

This understands exactly two methods and relays every other line byte for byte.

The protocol has two eras in circulation, one using `server/discover` with inline `_meta`
and one using the `initialize` handshake, and it keeps growing: `subscriptions/listen`,
`notifications/cancelled`, `InputRequiredResult`. A proxy built on a protocol library
would have to model all of it and would break on the next addition. A relay that forwards
what it does not recognise works across both eras and survives additions it has never
heard of. An unparseable line is passed along untouched, because this process is not the
arbiter of protocol validity; it is the arbiter of one question.

It also keeps the dependency count at one.

## Development

```sh
npm test            # end to end over real pipes, against a server that records calls
npm run typecheck
npm run smoke       # pack, install the tarball, run the installed binary
npm run build
```

The suite's central assertion is not that the client saw an error. It is that the refused
call is **absent from the upstream server's own record**. Breaking the interception so
calls are recorded and then forwarded anyway fails eight of the sixteen tests, which is
the behaviour a logger-pretending-to-be-a-guardrail would have.
