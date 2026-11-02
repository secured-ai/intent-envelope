# Decision conformance cases

`conformance/valid` and `conformance/invalid` ask whether an envelope is well formed.
These ask the harder question: given a well-formed envelope and a proposed tool call,
what must an enforcement point decide?

Each case is one proposed call. The files are plain JSON and deliberately carry no
Python, so the TypeScript implementation and anyone else's run the same suite and the
word "conformant" means the same thing in each.

## Case format

| Field | Meaning |
| --- | --- |
| `name` | What the case pins, in one line |
| `spec_rule` | The step in [specification section 3](../../spec/v0.1.md) that decides it |
| `decided_by` | Stable identifier for that rule, which the decision record must carry |
| `envelope` or `envelope_ref` | The envelope inline, or a path relative to this directory |
| `call` | The proposed call: `tool`, `arguments`, `data`, `recipients`, optional `estimated_cost_usd` and `context` |
| `state` | The run so far: `now`, `tool_calls_made`, `records_returned`, `spend_usd`, `runtime_seconds`, `recipients_contacted` |
| `expect` | `result` is one of `allow`, `deny`, `escalate`; `rule` must match `decided_by` |

A case passes when the implementation returns the expected result **and** names the same
rule. Returning `deny` for the wrong reason is a failure, because the reason is what the
operator reads in the ledger and what section 5 requires the record to carry.

## Two rules an implementation supplies

Section 7 leaves two things deployment-defined in 0.1, so the suite cannot test them in
the abstract and does not pretend to:

- **`data` addressing** has no normative syntax, so an implementation provides the
  matcher. Cases 05 and 06 use simple string prefixes.
- **`escalate.when`** has no standard expression syntax, so an implementation provides
  the predicate. Case 12 supplies the operands under `call.context`.

Everything else is decided by the specification alone.

## The case that matters most

`13-deny-beats-escalate` is the one to run first when porting. Both an escalate
condition and a deny rule match the same call. Section 3 evaluates deny first, so a
forbidden action is never put in front of a person as something they could approve. An
implementation that escalates there is wrong in a way that looks like a feature.

## Running them

```
python -m pytest packages/python/tests -q
```

The suite fails until an evaluator exists. That is the point: the cases were written
before the code, from the specification and from the attack patterns in the
[incident library](https://securedai.org/incidents).
