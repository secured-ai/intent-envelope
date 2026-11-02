"""The enforcement point: an envelope, the run so far, and a wrapper for a tool call.

`evaluate` decides one call in isolation. Something has to hold the run together, or
limits mean nothing: `max_tool_calls` is only a limit if somebody counts, and the agent
counting its own calls is the arrangement this whole specification exists to replace.

`EnforcementPoint` keeps that count outside the agent and refuses on its own authority.
`guard` wraps an existing tool-call function, so a deployment adds enforcement without
restructuring its agent. MCP first, because one integration covers every tool a server
exposes, which is the cheapest reach available.

Nothing here can be switched off by the thing it governs. There is no argument an agent
can pass that widens the envelope, and no exception path that trusts the caller's
explanation of why this call should be different.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .evaluate import (
    ALLOW,
    DENY,
    ESCALATE,
    Call,
    Decision,
    RunState,
    default_condition_matcher,
    default_data_matcher,
    evaluate,
)

__all__ = ["EnforcementPoint", "ToolFacts", "default_facts", "Refused", "Escalated"]


class Refused(PermissionError):
    """Raised when a guarded tool call is denied. Carries the decision and its record."""

    def __init__(self, decision: Decision):
        self.decision = decision
        super().__init__(f"{decision.rule}: {decision.detail}")


class Escalated(PermissionError):
    """Raised when a guarded call needs a named human before it can run.

    Separate from Refused on purpose. A deployment that treats them alike has collapsed
    "a person must decide this" into "no", which loses the entire point of having an
    escalation path. What waits for the human, and what happens when nobody answers, is
    the deployment's to build: `on_no_response` in the envelope says which way it falls.
    """

    def __init__(self, decision: Decision):
        self.decision = decision
        super().__init__(f"needs {decision.escalate_to}: {decision.detail}")


@dataclass
class ToolFacts:
    """What a call touches, in the terms the envelope is written in.

    MCP carries a tool name and arguments and nothing else, so somebody has to say which
    argument is a recipient and which is a data target. That mapping is deployment
    knowledge, not protocol.
    """

    data: List[str] = field(default_factory=list)
    recipients: List[str] = field(default_factory=list)
    estimated_cost_usd: float = 0.0
    context: Dict[str, Any] = field(default_factory=dict)


# Conventional argument names, listed rather than guessed at from the shape of values.
_RECIPIENT_KEYS = ("to", "recipient", "recipients", "to_address", "email", "send_to", "channel")
_DATA_KEYS = ("data", "dataset", "collection", "collections", "resource", "resources", "scope")


def default_facts(tool: str, arguments: Dict[str, Any]) -> ToolFacts:
    """Read conventional argument names. Documented, small, and easy to outgrow.

    A deployment whose tools name things differently passes its own `facts=`. The
    failure mode worth knowing: a recipient this does not recognise is a recipient the
    envelope never checks, so a tool that can send should have its extractor written
    rather than inherited.
    """

    def collect(keys: tuple) -> List[str]:
        found: List[str] = []
        for key in keys:
            value = arguments.get(key)
            if isinstance(value, str):
                found.append(value)
            elif isinstance(value, (list, tuple)):
                found.extend(str(v) for v in value)
        return found

    return ToolFacts(
        data=collect(_DATA_KEYS),
        recipients=collect(_RECIPIENT_KEYS),
        context={k: v for k, v in arguments.items() if isinstance(v, (int, float, bool, str))},
    )


class EnforcementPoint:
    """Holds one envelope and one run, and decides every call in it."""

    def __init__(
        self,
        envelope: Dict[str, Any],
        *,
        facts: Callable[[str, Dict[str, Any]], ToolFacts] = default_facts,
        on_decision: Optional[Callable[[Decision], None]] = None,
        data_matcher: Callable[[str, str], bool] = default_data_matcher,
        condition_matcher: Callable[[str, Dict[str, Any]], bool] = default_condition_matcher,
        now: Optional[Callable[[], str]] = None,
    ):
        self.envelope = envelope
        self.facts = facts
        self.on_decision = on_decision
        self.data_matcher = data_matcher
        self.condition_matcher = condition_matcher
        self._now = now
        self.state = RunState()
        self.decisions: List[Decision] = []

    # ---------------------------------------------------------------- deciding

    def check(self, tool: str, arguments: Optional[Dict[str, Any]] = None, **overrides: Any) -> Decision:
        """Decide a call without running it. Records the decision either way."""
        arguments = arguments or {}
        found = self.facts(tool, arguments)
        call = Call(
            tool=tool,
            arguments=arguments,
            data=overrides.get("data", found.data),
            recipients=overrides.get("recipients", found.recipients),
            estimated_cost_usd=overrides.get("estimated_cost_usd", found.estimated_cost_usd),
            context={**found.context, **overrides.get("context", {})},
        )
        if self._now:
            self.state.now = self._now()

        decision = evaluate(
            self.envelope, call, self.state,
            data_matcher=self.data_matcher, condition_matcher=self.condition_matcher,
        )

        # Every outcome is recorded, refused as well as allowed. A ledger that holds only
        # what succeeded cannot answer the question an incident actually asks.
        self.decisions.append(decision)
        if self.on_decision:
            self.on_decision(decision)

        # Only a call that is going to happen spends the run's budget. Counting refused
        # calls against the limit would let a blocked agent exhaust its own allowance.
        if decision.result == ALLOW:
            self.state.tool_calls_made += 1
            self.state.spend_usd += call.estimated_cost_usd
            self.state.recipients_contacted += len(call.recipients)
        return decision

    def enforce(self, tool: str, arguments: Optional[Dict[str, Any]] = None, **overrides: Any) -> Decision:
        """Decide, and raise unless the answer is allow."""
        decision = self.check(tool, arguments, **overrides)
        if decision.result == DENY:
            raise Refused(decision)
        if decision.result == ESCALATE:
            raise Escalated(decision)
        return decision

    # ---------------------------------------------------------------- wrapping

    def guard(self, call_tool: Callable) -> Callable:
        """Wrap a tool-call function so every call through it is checked first.

        Works with an MCP client's `call_tool(name, arguments)` as it stands, sync or
        async. The check happens before the call, because a decision made afterwards is
        a report rather than a control.
        """
        if inspect.iscoroutinefunction(call_tool):

            async def guarded_async(name: str, arguments: Optional[Dict[str, Any]] = None, *args: Any, **kwargs: Any):
                self.enforce(name, arguments or {})
                return await call_tool(name, arguments or {}, *args, **kwargs)

            guarded_async.__name__ = getattr(call_tool, "__name__", "call_tool")
            guarded_async.enforcement_point = self  # type: ignore[attr-defined]
            return guarded_async

        def guarded(name: str, arguments: Optional[Dict[str, Any]] = None, *args: Any, **kwargs: Any):
            self.enforce(name, arguments or {})
            return call_tool(name, arguments or {}, *args, **kwargs)

        guarded.__name__ = getattr(call_tool, "__name__", "call_tool")
        guarded.enforcement_point = self  # type: ignore[attr-defined]
        return guarded

    # ---------------------------------------------------------------- the ledger

    def ledger(self) -> List[Dict[str, Any]]:
        """Every decision this run made, in order, as section 5 records."""
        return [d.record() for d in self.decisions]

    def summary(self) -> Dict[str, int]:
        counts = {ALLOW: 0, DENY: 0, ESCALATE: 0}
        for d in self.decisions:
            counts[d.result] += 1
        return counts
