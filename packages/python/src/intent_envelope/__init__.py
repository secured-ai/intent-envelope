"""Declared intent envelopes for AI agents.

An envelope states what an agent is for: the tools it may call, the data it may
touch, who it may contact, what it may spend, and which actions need a human.
It is written before the agent runs and checked in code at every tool call.

Two halves. `validate` answers whether an envelope is well formed. `evaluate` and
`EnforcementPoint` answer the question that matters at runtime: given this envelope,
may this call happen, and on whose authority was that decided.

Specification: https://securedai.org/agent-intent
"""

from .enforce import EnforcementPoint, Escalated, Refused, ToolFacts, default_facts
from .evaluate import (
    Call,
    Decision,
    RunState,
    UnsupportedCondition,
    default_condition_matcher,
    default_data_matcher,
    evaluate,
)
from .validate import ValidationError, load_schema, validate

__version__ = "0.1.0"
__all__ = [
    # envelopes
    "validate",
    "load_schema",
    "ValidationError",
    # decisions
    "evaluate",
    "Call",
    "RunState",
    "Decision",
    "UnsupportedCondition",
    "default_data_matcher",
    "default_condition_matcher",
    # enforcement
    "EnforcementPoint",
    "ToolFacts",
    "default_facts",
    "Refused",
    "Escalated",
    "__version__",
]
