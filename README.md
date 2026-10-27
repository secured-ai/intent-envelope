# Intent Envelope

**Your agent was not hacked. It was told what to do, just not by you.**

An agent reads documents, tickets, web pages and tool output. Any of them can contain
instructions. Over a long task the goal you gave and the goal the agent is pursuing can
separate, and nothing in a typical stack can tell the difference at the moment a tool
call is made.

An intent envelope is a short, versioned, reviewable declaration of what an agent is
for: which tools it may call, which data it may touch, who it may contact, what it may
spend, and which actions always need a named human. It is written before the agent runs
and enforced in code at every tool call, so the boundary does not depend on the model
behaving.

```json
{
  "intent_envelope": "0.1",
  "id": "invoice-reconciliation",
  "purpose": "Reconcile this month's supplier invoices against purchase orders.",
  "principal": { "agent_identity": "invoice-agent", "on_behalf_of": "accounts-payable" },
  "tools": {
    "allow": [{ "name": "read_file", "constraints": { "path_prefix": ["/invoices/current-month/"] } }],
    "deny": ["send_email", "http_request"]
  },
  "limits": { "max_tool_calls": 400, "max_spend_usd": 20 },
  "on_no_response": "deny"
}
```

A document asking that agent to email the vendor list somewhere is not refused because a
model recognised the trick. It is refused because `send_email` was never in the envelope.

## What is here

| Path | What it is |
| --- | --- |
| `spec/v0.1.md` | The specification. One page. |
| `schema/intent-envelope-0.1.json` | JSON Schema, published at `https://securedai.org/schemas/intent-envelope/0.1.json` |
| `examples/` | Worked envelopes for three common deployments |
| `conformance/` | Envelopes that must validate, and envelopes that must not |
| `packages/python/` | The `intent-envelope` validator and CLI |

## Try it

```
pip install intent-envelope
intent-envelope validate examples/invoice-reconciliation.json
```

## Status

Version 0.1 is a draft we are implementing against. The schema may change before 1.0,
and section 8 of the spec lists what we have deliberately left open. If you are building
agents and any of it is wrong for your deployment, open an issue. That is more useful to
us than agreement.

## Why this is open

The envelope is only worth anything if more than one vendor enforces it, so the spec and
the reference implementation are free and will stay that way under the licenses below.
SecuredAI builds the enforcement and governance around it: https://securedai.org/products

The architecture this belongs to is published in full at
https://securedai.org/architecture

## License

The specification text is CC-BY-4.0. The code is Apache-2.0. See `LICENSE` and
`LICENSE-SPEC`.
