"""Every case in conformance/decisions must get the right result for the right reason.

These were written before the evaluator, from specification section 3 and from the
attack patterns in the incident library. The behaviour is pinned by the specification
and by this suite, not by whatever the first implementation happens to do.

Until `intent_envelope.evaluate` exists they are marked xfail(strict=True), so the
branch is honest in both directions: CI stays green while there is nothing to evaluate,
and the moment the evaluator starts returning correct answers these turn into XPASS
failures that force the marker off. An expected failure that quietly becomes an
expected pass is how a suite stops meaning anything.

The cases are language-neutral JSON. The TypeScript port runs the same files.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
CASES = sorted((ROOT / "conformance" / "decisions").glob("*.json"))

# Imported lazily so collection still reports every case as a failure with a readable
# reason, rather than erroring out at import time before any of them are listed.
try:
    from intent_envelope.evaluate import Call, RunState, evaluate  # type: ignore

    EVALUATOR_MISSING = None
except ImportError as exc:  # pragma: no cover - the state this suite starts in
    EVALUATOR_MISSING = str(exc)


def load_case(path: Path) -> dict:
    case = json.loads(path.read_text(encoding="utf-8"))
    if "envelope_ref" in case:
        case["envelope"] = json.loads((path.parent / case["envelope_ref"]).read_text(encoding="utf-8"))
    return case


def test_cases_exist():
    assert CASES, "no decision cases found in conformance/decisions"


def test_every_case_is_well_formed():
    """A malformed case would silently pass or silently never run."""
    results = {"allow", "deny", "escalate"}
    for path in CASES:
        case = load_case(path)
        for field in ("name", "spec_rule", "decided_by", "call", "state", "expect"):
            assert field in case, f"{path.name} has no {field}"
        assert case["expect"]["result"] in results, f"{path.name} expects an unknown result"
        assert case["expect"]["rule"] == case["decided_by"], (
            f"{path.name}: expect.rule and decided_by disagree, so the case cannot check "
            f"that the right rule decided it"
        )
        assert "tool" in case["call"], f"{path.name} proposes no tool"


def test_the_suite_covers_every_step_of_section_3():
    """Section 3 has nine steps. A suite that skips one lets an implementation skip it."""
    covered = {load_case(p)["spec_rule"] for p in CASES}
    missing = set(range(1, 10)) - covered
    assert not missing, f"no decision case covers section 3 step(s): {sorted(missing)}"


needs_evaluator = pytest.mark.xfail(
    EVALUATOR_MISSING is not None,
    reason="no evaluator yet: these cases are written first, from the specification",
    strict=True,
)


@needs_evaluator
@pytest.mark.parametrize("path", CASES, ids=lambda p: p.stem)
def test_decision(path: Path):
    case = load_case(path)
    decision = evaluate(
        envelope=case["envelope"],
        call=Call(**case["call"]),
        state=RunState(**case["state"]),
    )

    expected = case["expect"]
    assert decision.result == expected["result"], (
        f"{case['name']}: expected {expected['result']}, got {decision.result}"
    )
    # The reason is not decoration. Section 5 requires the record to name the rule that
    # decided, and an operator reading the ledger acts on that field.
    assert decision.rule == expected["rule"], (
        f"{case['name']}: right answer, wrong reason. Expected rule {expected['rule']}, "
        f"got {decision.rule}"
    )


@needs_evaluator
@pytest.mark.parametrize("path", CASES, ids=lambda p: p.stem)
def test_decision_produces_a_record(path: Path):
    """Section 5: every evaluation SHOULD produce one record, written where the decision
    is made. The plan calls for this from the start rather than bolted on later."""
    case = load_case(path)
    decision = evaluate(
        envelope=case["envelope"],
        call=Call(**case["call"]),
        state=RunState(**case["state"]),
    )
    record = decision.record()

    for field in ("envelope_id", "revision", "agent_identity", "principal", "tool", "result", "rule", "decided_at"):
        assert field in record, f"the decision record has no {field}, which section 5 requires"
    assert record["envelope_id"] == case["envelope"]["id"]
    assert record["result"] == case["expect"]["result"]
    assert record["rule"] == case["expect"]["rule"]
