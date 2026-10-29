"""expires must be a real RFC 3339 instant, not merely a string.

Section 3 denies every call under an expired envelope, so an enforcement point has
to parse this value. jsonschema treats "format" as an annotation unless a checker is
supplied, and the date-time checker only exists when rfc3339-validator is installed,
so two separate things have to stay true for expires to mean anything. These tests
fail if either one is undone.
"""

import pytest

from intent_envelope.validate import ValidationError, validate


def envelope(**overrides):
    base = {
        "intent_envelope": "0.1",
        "id": "expiry-fixture-agent",
        "revision": 1,
        "purpose": "A minimal valid envelope used to test the expires field in isolation.",
        "principal": {"agent_identity": "fixture-agent"},
        "tools": {"allow": [{"name": "kb_search"}]},
        "limits": {"max_tool_calls": 1},
        "on_no_response": "deny",
    }
    base.update(overrides)
    return base


def test_the_fixture_itself_is_valid_without_expires():
    validate(envelope())


@pytest.mark.parametrize(
    "value",
    [
        "2027-01-01T00:00:00Z",
        "2027-01-01T00:00:00.500Z",
        "2027-01-01T12:00:00+05:30",
        "2028-02-29T00:00:00Z",  # 2028 is a leap year
    ],
)
def test_real_instants_are_accepted(value):
    validate(envelope(expires=value))


@pytest.mark.parametrize(
    "value",
    [
        "NOT A DATE",
        "",
        "2026-13-01T00:00:00Z",   # month 13
        "2026-02-30T00:00:00Z",   # day that does not exist
        "2026-01-01T25:00:00Z",   # hour 25
        "2026-01-01",             # date with no time
        "01/01/2026",             # a different calendar convention entirely
        "2026-01-01T00:00:00",    # no offset, so not a fixed instant
    ],
)
def test_strings_that_are_not_instants_are_rejected(value):
    with pytest.raises(ValidationError) as caught:
        validate(envelope(expires=value))
    assert any("expires" in problem for problem in caught.value.problems), (
        f"{value!r} was rejected, but the problem did not name expires: {caught.value.problems}"
    )


def test_the_date_time_checker_is_actually_installed():
    """Guards the dependency rather than the code.

    If rfc3339-validator goes missing, FormatChecker keeps working and silently stops
    checking date-time, so every test above would still pass while expires quietly
    accepted anything. This asserts the checker exists.
    """
    from jsonschema import FormatChecker

    assert "date-time" in FormatChecker().checkers, (
        "no date-time format checker is registered, so expires is not being validated. "
        "Install rfc3339-validator."
    )
