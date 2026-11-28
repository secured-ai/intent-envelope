"""Intent Envelope 0.2: amendments, component admission and the 0.2 schema.

The same conformance folders the TypeScript implementation runs. The decision cases for
the four new rules run with every other case in test_decisions.py.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from intent_envelope.amend import admit_component, canonical, check_amendment, widening
from intent_envelope.evaluate import Call, RunState, evaluate, host_matches
from intent_envelope.validate import ValidationError, validate

ROOT = Path(__file__).resolve().parents[3]


def _folder(name: str):
    out = []
    d = ROOT / "conformance" / name
    for f in sorted(d.glob("*.json")):
        body = json.loads(f.read_text(encoding="utf-8"))
        for k in ("current_ref", "envelope_ref"):
            if k in body:
                body[k.replace("_ref", "")] = json.loads((d / body[k]).resolve().read_text(encoding="utf-8"))
        out.append(pytest.param(body, id=f.stem))
    return out


def test_v02_envelope_validates_and_its_fields_are_refused_under_01():
    env = json.loads((ROOT / "conformance/valid/refund-desk-0.2.json").read_text())
    validate(env)
    with pytest.raises(ValidationError) as caught:
        validate({**env, "intent_envelope": "0.1"})
    text = " ".join(caught.value.problems)
    for field in ("egress", "credentials", "amendment", "components"):
        assert field in text


@pytest.mark.parametrize("case", _folder("amendments"))
def test_amendment(case):
    r = check_amendment(case["current"], case["proposed"], case["signature"], lambda: "2026-11-28T12:00:00Z")
    assert r.accepted == case["expect"]["accepted"], r.reasons
    if "widening" in case["expect"]:
        assert r.widening == case["expect"]["widening"]
    if "reason" in case["expect"]:
        assert case["expect"]["reason"] in r.reasons, r.reasons
    assert r.record()["result"] == ("accepted" if r.accepted else "rejected")


@pytest.mark.parametrize("case", _folder("components"))
def test_component(case):
    r = admit_component(case["envelope"], case["manifest"])
    assert r.admitted == case["expect"]["admitted"]
    assert r.reasons == case["expect"]["reasons"]


def test_canonical_matches_the_typescript_bytes():
    assert canonical({"b": 2.0, "a": [1.5, "x", None, True], "c": {"z": 0, "y": -3}}) == '{"a":[1.5,"x",null,true],"b":2,"c":{"y":-3,"z":0}}'


def test_host_matching():
    assert host_matches("API.example.com.", "api.example.com")
    assert host_matches("a.b.example.com", ".example.com")
    assert host_matches("a.example.com", "*.example.com")
    assert not host_matches("example.com", ".example.com")
    assert not host_matches("badexample.com", ".example.com")
    assert host_matches("169.254.169.254", "169.254.0.0/16")
    assert not host_matches("169.255.0.1", "169.254.0.0/16")


def test_01_examples_decide_as_before():
    for f in sorted((ROOT / "examples").glob("*.json")):
        env = json.loads(f.read_text())
        tool = env["tools"]["allow"][0]["name"]
        plain = evaluate(env, Call(tool=tool), RunState(now="2026-11-28T12:00:00Z"))
        more = evaluate(env, Call(tool=tool, egress=["anything.example"], processors=["anyone"]), RunState(now="2026-11-28T12:00:00Z"))
        assert (plain.result, plain.rule) == (more.result, more.rule), f.name


def test_egress_baseline_pack():
    env = json.loads((ROOT / "packs/egress-metadata-baseline/example-envelope.json").read_text())
    validate(env)
    cred = {"run_id": "r1", "issued_at": "2026-11-28T12:00:00Z", "expires_at": "2026-11-28T12:10:00Z"}
    state = RunState(now="2026-11-28T12:01:00Z", run_id="r1")
    for host in ("169.254.169.254", "metadata.google.internal", "10.0.4.2", "kubernetes.default.svc"):
        d = evaluate(env, Call(tool="fetch_url", egress=[host], credential=cred), state)
        assert (d.result, d.rule) == ("deny", "egress"), host
    assert evaluate(env, Call(tool="fetch_url", egress=["help.example.com"], credential=cred), state).result == "allow"
