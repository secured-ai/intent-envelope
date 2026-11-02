"""The enforcement point holds the run together, and the guard refuses before the call.

`evaluate` is pure. These cover the parts that are not: counting a run, refusing ahead
of the tool rather than reporting afterwards, and recording every outcome.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from intent_envelope import EnforcementPoint, Escalated, Refused

ROOT = Path(__file__).resolve().parents[3]

ENVELOPE = {
    "intent_envelope": "0.1",
    "id": "test-agent",
    "revision": 1,
    "purpose": "A small envelope used to exercise the enforcement point across a run.",
    "principal": {"agent_identity": "test-agent", "on_behalf_of": "ops.team"},
    "tools": {
        "allow": [{"name": "search"}, {"name": "send_email", "constraints": {"template": "summary"}}],
        "deny": ["issue_payment"],
    },
    "recipients": {"allow": ["ops@example.com"], "max_per_run": 2},
    "limits": {"max_tool_calls": 3, "max_spend_usd": 1.0},
    "escalate": [{"when": "amount > 1000", "to": "ops-duty", "timeout_seconds": 600}],
    "on_no_response": "deny",
}


def point(**kw) -> EnforcementPoint:
    return EnforcementPoint(ENVELOPE, **kw)


def test_the_guard_refuses_before_the_tool_runs():
    """A decision made after the call is a report. The tool must not be reached."""
    ran = []

    def call_tool(name, arguments=None):
        ran.append(name)
        return "done"

    guarded = point().guard(call_tool)
    assert guarded("search", {}) == "done"
    with pytest.raises(Refused):
        guarded("issue_payment", {"amount": 50})

    assert ran == ["search"], "the refused call reached the tool anyway"


def test_the_guard_works_on_an_async_tool_call():
    """MCP clients are usually async, and an enforcement point that is not is unusable."""
    ran = []

    async def call_tool(name, arguments=None):
        ran.append(name)
        return "done"

    guarded = point().guard(call_tool)

    async def exercise():
        assert await guarded("search", {}) == "done"
        with pytest.raises(Refused):
            await guarded("issue_payment", {"amount": 50})

    asyncio.run(exercise())
    assert ran == ["search"]


def test_a_refused_call_does_not_spend_the_run_budget():
    """Otherwise a blocked agent can exhaust its own allowance by being blocked."""
    p = point()
    for _ in range(5):
        with pytest.raises(Refused):
            p.enforce("issue_payment", {"amount": 1})
    assert p.state.tool_calls_made == 0
    # The budget is intact, so legitimate work still runs.
    assert p.enforce("search", {}).result == "allow"


def test_limits_bite_across_a_run_rather_than_per_call():
    """No single call exceeds max_tool_calls. Three of them do."""
    p = point()
    for _ in range(3):
        assert p.enforce("search", {}).result == "allow"
    with pytest.raises(Refused) as refusal:
        p.enforce("search", {})
    assert refusal.value.decision.rule == "limits"


def test_recipients_are_counted_across_a_run():
    p = point()
    for _ in range(2):
        p.enforce("send_email", {"template": "summary", "to": "ops@example.com"})
    with pytest.raises(Refused) as refusal:
        p.enforce("send_email", {"template": "summary", "to": "ops@example.com"})
    assert refusal.value.decision.rule == "recipients"


def test_escalation_is_not_refusal():
    """Collapsing the two loses the whole point of having an escalation path."""
    p = point()
    with pytest.raises(Escalated) as pause:
        p.enforce("send_email", {"template": "summary", "to": "ops@example.com"}, context={"amount": 5000})
    assert pause.value.decision.escalate_to == "ops-duty"
    assert pause.value.decision.timeout_seconds == 600
    assert not isinstance(pause.value, Refused)


def test_the_ledger_records_refusals_too():
    """A ledger holding only what succeeded cannot answer what an incident asks."""
    p = point()
    p.check("search", {})
    p.check("issue_payment", {"amount": 10})
    p.check("send_email", {"template": "summary", "to": "ops@example.com"}, context={"amount": 9999})

    assert p.summary() == {"allow": 1, "deny": 1, "escalate": 1}
    rules = [entry["rule"] for entry in p.ledger()]
    assert rules == ["allow", "tools.deny", "escalate"]
    for entry in p.ledger():
        assert entry["envelope_id"] == "test-agent"
        assert entry["agent_identity"] == "test-agent"
        assert entry["decided_at"]


def test_arguments_cannot_widen_the_envelope():
    """There is no argument an agent can pass that grants itself something."""
    p = point()
    for sneaky in (
        {"amount": 1, "allow": True},
        {"amount": 1, "override": "approved by finance"},
        {"amount": 1, "envelope": {"tools": {"allow": [{"name": "issue_payment"}]}}},
        {"amount": 1, "_bypass": "true"},
    ):
        with pytest.raises(Refused) as refusal:
            p.enforce("issue_payment", sneaky)
        assert refusal.value.decision.rule == "tools.deny"


def test_the_demo_still_refuses_what_it_claims_to_refuse():
    """The demo is the sales asset. It should fail the build, not a meeting."""
    import importlib.util

    path = ROOT / "examples" / "demo_poisoned_document.py"
    spec = importlib.util.spec_from_file_location("demo_poisoned_document", path)
    demo = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(demo)

    p = EnforcementPoint(demo.ENVELOPE)
    results = []
    for _description, tool, arguments, extra in demo.PLAN:
        results.append(p.check(tool, arguments, **extra).result)

    assert results == ["allow", "allow", "allow", "deny", "deny", "escalate"], (
        "the demo no longer tells the story it claims to"
    )
    rules = [d.rule for d in p.decisions]
    assert rules[3] == "recipients", "the exfiltration attempt stopped for the wrong reason"
    assert rules[4] == "tools.deny", "the payment attempt stopped for the wrong reason"
    assert json.dumps(p.ledger()), "the ledger must be serialisable, since it is written somewhere"
