"""Decide one proposed tool call against an envelope.

This is specification section 3, in its order, and the order is the design rather than
an implementation detail. Deny is settled before escalate so a forbidden action is never
put in front of a person as something they could approve.

Two rules depend on things version 0.1 leaves deployment-defined: how `data` targets are
addressed, and the expression syntax in `escalate.when`. Both are injectable. The
defaults here are documented and deliberately small, because a matcher that quietly
guesses is worse than one that refuses.

Nothing in this module consults the model, the prompt, or the agent's stated reason for
the call. It reads the envelope, the call, and the run so far.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence

__all__ = [
    "Call",
    "RunState",
    "Decision",
    "evaluate",
    "UnsupportedCondition",
    "default_data_matcher",
    "default_condition_matcher",
]

ALLOW, DENY, ESCALATE = "allow", "deny", "escalate"


class UnsupportedCondition(ValueError):
    """Raised when the default matcher cannot parse an `escalate.when` expression.

    Refusing is the point. Returning False for an expression nobody understood would
    silently turn an action that should have paused for a human into one that ran.
    """


@dataclass
class Call:
    """One proposed tool call, as the enforcement point sees it.

    `context` carries the operands an `escalate.when` expression refers to, and anything
    a deployment's own matchers need. It is evidence about the call, never instructions:
    nothing in it can widen the envelope.
    """

    tool: str
    arguments: Dict[str, Any] = field(default_factory=dict)
    data: List[str] = field(default_factory=list)
    recipients: List[str] = field(default_factory=list)
    estimated_cost_usd: float = 0.0
    context: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RunState:
    """What this run has already spent. Limits are arithmetic over this, not judgement."""

    now: str = ""
    tool_calls_made: int = 0
    records_returned: int = 0
    spend_usd: float = 0.0
    runtime_seconds: int = 0
    recipients_contacted: int = 0


@dataclass
class Decision:
    result: str
    rule: str
    detail: str
    envelope: Dict[str, Any]
    call: Call
    decided_at: str
    escalate_to: Optional[str] = None
    timeout_seconds: Optional[int] = None

    @property
    def allowed(self) -> bool:
        return self.result == ALLOW

    def record(self) -> Dict[str, Any]:
        """The record specification section 5 asks for.

        Written here, where the decision is made, because this is the only place that
        holds the envelope, the identity, the call and the verdict at the same time.
        Assembling it from logs afterwards means reconstructing a decision from its
        side effects.
        """
        principal = self.envelope.get("principal") or {}
        return {
            "envelope_id": self.envelope.get("id"),
            "revision": self.envelope.get("revision"),
            "agent_identity": principal.get("agent_identity"),
            "principal": principal.get("on_behalf_of"),
            "tool": self.call.tool,
            "target": self.call.recipients or self.call.data or None,
            "result": self.result,
            "rule": self.rule,
            "detail": self.detail,
            "cost_usd": self.call.estimated_cost_usd,
            "escalated_to": self.escalate_to,
            "decided_at": self.decided_at,
        }


# --------------------------------------------------------------------- matchers


def default_data_matcher(target: str, pattern: str) -> bool:
    """Exact match, or the pattern naming a prefix segment of the target.

    `ledger:read` matches `ledger:read:current_month`. `ledger` matches both. Version
    0.1 leaves addressing to the deployment, so anything richer belongs in a matcher the
    deployment supplies.
    """
    if target == pattern:
        return True
    return target.startswith(pattern + ":") or target.startswith(pattern + ".")


_COMPARISON = re.compile(
    r"^\s*(?P<key>[A-Za-z_][\w.]*)\s*(?P<op>==|!=|>=|<=|>|<)\s*(?P<value>'[^']*'|\"[^\"]*\"|-?\d+(?:\.\d+)?)\s*$"
)
_BARE = re.compile(r"^\s*(?P<key>[A-Za-z_][\w.]*)\s*$")


def default_condition_matcher(condition: str, context: Dict[str, Any]) -> bool:
    """A deliberately small subset: `key`, or `key <op> number|'string'`.

    An operand the context does not carry is not a match, because the deployment did not
    report the thing the condition asks about. An expression this cannot parse raises,
    because guessing at an escalation rule is how an action that should have paused runs
    instead.
    """
    bare = _BARE.match(condition)
    if bare:
        return bool(context.get(bare.group("key")))

    m = _COMPARISON.match(condition)
    if not m:
        raise UnsupportedCondition(
            f"cannot parse escalate.when {condition!r}. Version 0.1 defines no expression "
            f"syntax, so supply condition_matcher= for this deployment's own."
        )

    key, op, raw = m.group("key"), m.group("op"), m.group("value")
    if key not in context:
        return False
    actual = context[key]
    expected: Any = raw[1:-1] if raw[0] in "'\"" else float(raw)

    if op == "==":
        return actual == expected or str(actual) == str(expected)
    if op == "!=":
        return not (actual == expected or str(actual) == str(expected))
    try:
        actual_number = float(actual)
    except (TypeError, ValueError):
        return False
    return {
        ">": actual_number > expected,
        "<": actual_number < expected,
        ">=": actual_number >= expected,
        "<=": actual_number <= expected,
    }[op]


# --------------------------------------------------------------------- helpers


def _parse_instant(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _grant_for(envelope: Dict[str, Any], tool: str) -> Optional[Dict[str, Any]]:
    for grant in (envelope.get("tools") or {}).get("allow") or []:
        if grant.get("name") == tool:
            return grant
    return None


def _constraint_violation(grant: Dict[str, Any], arguments: Dict[str, Any]) -> Optional[str]:
    """Default constraint semantics, documented rather than inferred.

    `max_*` bounds above, `min_*` bounds below, anything else must equal exactly. An
    argument the call omits is unbounded for max/min and a violation for an equality
    constraint, because an omitted pin is how a constraint gets sidestepped.
    """
    for key, expected in (grant.get("constraints") or {}).items():
        actual = arguments.get(key)
        if key.startswith("max_"):
            if actual is not None and _as_number(actual) is not None and _as_number(actual) > _as_number(expected):
                return f"{key} is {actual}, above the permitted {expected}"
        elif key.startswith("min_"):
            if actual is not None and _as_number(actual) is not None and _as_number(actual) < _as_number(expected):
                return f"{key} is {actual}, below the permitted {expected}"
        elif actual is None:
            return f"{key} is pinned to {expected!r} and the call did not supply it"
        elif actual != expected:
            return f"{key} is {actual!r}, not the pinned {expected!r}"
    return None


def _as_number(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _limit_exceeded(limits: Dict[str, Any], call: Call, state: RunState) -> Optional[str]:
    max_calls = limits.get("max_tool_calls")
    if max_calls is not None and state.tool_calls_made + 1 > max_calls:
        return f"this is call {state.tool_calls_made + 1} of a permitted {max_calls}"

    max_spend = limits.get("max_spend_usd")
    if max_spend is not None and state.spend_usd + call.estimated_cost_usd > max_spend:
        total = state.spend_usd + call.estimated_cost_usd
        return f"this call would take spend to {total:.2f} of a permitted {max_spend}"

    max_records = limits.get("max_records")
    if max_records is not None and state.records_returned >= max_records:
        return f"{state.records_returned} records returned, of a permitted {max_records}"

    max_runtime = limits.get("max_runtime_seconds")
    if max_runtime is not None and state.runtime_seconds > max_runtime:
        return f"the run has lasted {state.runtime_seconds}s, of a permitted {max_runtime}"
    return None


# --------------------------------------------------------------------- the decision


def evaluate(
    envelope: Dict[str, Any],
    call: Call,
    state: Optional[RunState] = None,
    *,
    data_matcher: Callable[[str, str], bool] = default_data_matcher,
    condition_matcher: Callable[[str, Dict[str, Any]], bool] = default_condition_matcher,
) -> Decision:
    """Return exactly one of allow, deny or escalate, and the rule that decided it."""
    state = state or RunState()
    decided_at = state.now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    def verdict(result: str, rule: str, detail: str, **extra: Any) -> Decision:
        return Decision(
            result=result, rule=rule, detail=detail, envelope=envelope,
            call=call, decided_at=decided_at, **extra,
        )

    tools = envelope.get("tools") or {}

    # 1. An envelope past its expiry denies everything. The check belongs here, at the
    #    moment of the call, not at the moment the envelope was issued.
    expires = envelope.get("expires")
    if expires:
        deadline, now = _parse_instant(expires), _parse_instant(state.now) if state.now else datetime.now(timezone.utc)
        if deadline is None:
            return verdict(DENY, "expires", f"expires is {expires!r}, which is not an instant this can compare")
        if now is not None and now >= deadline:
            return verdict(DENY, "expires", f"the envelope expired at {expires}")

    # 2. Deny always wins, before anything consults the allow list.
    if call.tool in (tools.get("deny") or []):
        return verdict(DENY, "tools.deny", f"{call.tool} is on tools.deny, which no later grant overrides")

    # 3. Silence is not permission.
    grant = _grant_for(envelope, call.tool)
    if grant is None:
        return verdict(DENY, "tools.allow", f"{call.tool} is not on tools.allow")

    # 4. The tool is granted. The arguments still have to be the ones that were granted.
    violation = _constraint_violation(grant, call.arguments)
    if violation:
        return verdict(DENY, "tools.constraints", violation)

    # 5. Data. An absent data block is unconstrained here, unlike recipients, because
    #    0.1 states the default for recipients and not for this one.
    data_rules = envelope.get("data")
    if data_rules is not None:
        for target in call.data:
            for pattern in data_rules.get("deny") or []:
                if data_matcher(target, pattern):
                    return verdict(DENY, "data", f"{target} matches data.deny entry {pattern}")
            allowed = data_rules.get("allow")
            if allowed is not None and not any(data_matcher(target, p) for p in allowed):
                return verdict(DENY, "data", f"{target} is not within data.allow")

    # 6. Recipients. An absent block means nobody, which the specification states.
    recipients_rules = envelope.get("recipients")
    if call.recipients:
        if recipients_rules is None:
            return verdict(DENY, "recipients", "the envelope names no recipients, which permits contacting nobody")
        permitted: Sequence[str] = recipients_rules.get("allow") or []
        for who in call.recipients:
            if not any(who == p or who.endswith(p) for p in permitted):
                return verdict(DENY, "recipients", f"{who} is not on recipients.allow")
        max_per_run = recipients_rules.get("max_per_run")
        if max_per_run is not None and state.recipients_contacted + len(call.recipients) > max_per_run:
            total = state.recipients_contacted + len(call.recipients)
            return verdict(DENY, "recipients", f"this call would contact {total} of a permitted {max_per_run}")

    # 7. Budgets are arithmetic, which is why they hold when judgement does not.
    exceeded = _limit_exceeded(envelope.get("limits") or {}, call, state)
    if exceeded:
        return verdict(DENY, "limits", exceeded)

    # 8. Only now, with the call established as permitted, may a human be asked.
    for rule in envelope.get("escalate") or []:
        when = rule.get("when")
        if when and condition_matcher(when, call.context):
            return verdict(
                ESCALATE, "escalate", f"{when} matched",
                escalate_to=rule.get("to"), timeout_seconds=rule.get("timeout_seconds"),
            )

    # 9. Nothing fired.
    return verdict(ALLOW, "allow", "inside the envelope")
