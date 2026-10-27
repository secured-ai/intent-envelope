"""Declared intent envelopes for AI agents.

An envelope states what an agent is for: the tools it may call, the data it may
touch, who it may contact, what it may spend, and which actions need a human.
It is written before the agent runs and checked in code at every tool call.

Specification: https://securedai.org/agent-intent
"""

from .validate import ValidationError, load_schema, validate

__version__ = "0.0.1"
__all__ = ["validate", "load_schema", "ValidationError", "__version__"]
