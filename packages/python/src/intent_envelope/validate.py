"""Validate an intent envelope against the published schema."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

SPEC_VERSION = "0.1"
_SCHEMA_FILE = f"intent-envelope-{SPEC_VERSION}.json"


class ValidationError(Exception):
    """Raised when an envelope does not conform to the schema.

    ``problems`` holds one readable line per failure, each naming the field at
    fault, so a caller can show a reviewer what to change.
    """

    def __init__(self, problems: List[str]):
        self.problems = problems
        super().__init__("; ".join(problems))


def load_schema() -> Dict[str, Any]:
    """Return the bundled JSON Schema for the supported specification version."""
    here = Path(__file__).resolve().parent
    for candidate in (here / "schema" / _SCHEMA_FILE, here.parents[3] / "schema" / _SCHEMA_FILE):
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise FileNotFoundError(f"bundled schema {_SCHEMA_FILE} not found")


def _where(error: Any) -> str:
    path = ".".join(str(p) for p in error.absolute_path)
    return path or "(root)"


def validate(envelope: Dict[str, Any]) -> None:
    """Validate an envelope. Returns None, raises ValidationError with every problem found."""
    from jsonschema import Draft202012Validator, FormatChecker

    # JSON Schema treats "format" as an annotation unless a checker is supplied, so
    # without this the validator accepts expires: "NOT A DATE". That is not a harmless
    # laxness here: section 3 denies every call under an expired envelope, which means an
    # enforcement point has to parse the value. A string that passes validation and then
    # fails to parse turns a deliberate expiry into undefined behaviour at the gate.
    validator = Draft202012Validator(load_schema(), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(envelope), key=lambda e: list(e.absolute_path))
    if errors:
        raise ValidationError([f"{_where(e)}: {e.message}" for e in errors])


def validate_file(path: str | Path) -> None:
    """Validate the envelope in a JSON file."""
    text = Path(path).read_text(encoding="utf-8")
    try:
        envelope = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValidationError([f"(root): not valid JSON: {exc}"]) from exc
    validate(envelope)
