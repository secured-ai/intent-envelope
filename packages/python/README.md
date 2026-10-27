# Intent Envelope

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/secured-ai/intent-envelope/badge)](https://scorecard.dev/viewer/?uri=github.com/secured-ai/intent-envelope)
[![CI](https://github.com/secured-ai/intent-envelope/actions/workflows/ci.yml/badge.svg)](https://github.com/secured-ai/intent-envelope/actions/workflows/ci.yml)

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
  "id": "crm-enrichment-agent",
  "purpose": "Research a named prospect from public sources and update that prospect's CRM record.",
  "principal": { "agent_identity": "enrichment-agent", "on_behalf_of": "revenue-operations" },
  "tools": {
    "allow": [
      { "name": "web_research", "constraints": { "max_queries": 12 } },
      { "name": "crm_write", "constraints": { "objects": ["contact"], "create_records": false } }
    ],
    "deny": ["send_email", "send_message", "delete_record"]
  },
  "limits": { "max_tool_calls": 150, "max_spend_usd": 8 },
  "escalate": [{ "when": "research.source_contains_instructions", "to": "revops-owner" }],
  "on_no_response": "deny"
}
```

A web page telling that agent to email its findings somewhere is not refused because a
model recognised the trick. It is refused because `send_email` was never in the envelope,
and the page saying so trips an escalation to a named human.

## What is here

| Path | What it is |
| --- | --- |
| `spec/v0.1.md` | The specification. One page. |
| `schema/intent-envelope-0.1.json` | JSON Schema, published at `https://securedai.org/schemas/intent-envelope/0.1.json` |
| `examples/` | Worked envelopes from three real engagements, anonymized |
| `conformance/` | Envelopes that must validate, and envelopes that must not |
| `packages/python/` | The `intent-envelope` validator and CLI |

## Try it

```
pip install intent-envelope
intent-envelope validate examples/crm-enrichment-agent.json
```

## The examples

Each one is drawn from an engagement published at https://securedai.org/case-studies,
anonymized and reduced to the envelope the remediated architecture enforces.

- **`fintech-support-chatbot`** — a customer support chatbot that had direct access to
  financial and identity PII. The envelope pins every lookup to the authenticated
  customer, so account access is enforced at the query layer rather than asked for in a
  system prompt.
- **`healthcare-policy-rag`** — an internal RAG system where over twenty source documents
  had no permission enforcement at the index. The envelope requires query-time source
  ACL checks on retrieval, and escalates rather than answering when that check cannot run.
- **`crm-enrichment-agent`** — an agent with standing access to research tools, CRM
  read and write, and outbound senders. The envelope removes the senders entirely,
  caps what may be written, and escalates when a researched page turns out to contain
  instructions.

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
