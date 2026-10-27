"""Every fixture in conformance/valid must pass, every one in conformance/invalid must fail."""

from pathlib import Path

import pytest

from intent_envelope.validate import ValidationError, validate_file

ROOT = Path(__file__).resolve().parents[3]
VALID = sorted((ROOT / "conformance" / "valid").glob("*.json"))
INVALID = sorted((ROOT / "conformance" / "invalid").glob("*.json"))


def test_fixtures_exist():
    assert VALID, "no valid fixtures found"
    assert INVALID, "no invalid fixtures found"


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_valid_envelopes_pass(path):
    validate_file(path)


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_invalid_envelopes_fail(path):
    with pytest.raises(ValidationError) as caught:
        validate_file(path)
    assert caught.value.problems, "a rejection must say which field was at fault"


@pytest.mark.parametrize("path", sorted((ROOT / "examples").glob("*.json")), ids=lambda p: p.name)
def test_examples_are_valid(path):
    validate_file(path)
