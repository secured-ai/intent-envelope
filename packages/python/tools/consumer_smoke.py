#!/usr/bin/env python3
"""Build the package, install the wheel into a clean venv, and make a decision with it.

This exists because of 0.0.1. That release went to PyPI carrying only the validator,
while the README documented an enforcement point, so `pip install intent-envelope`
followed by the README's own example raised ImportError. Every test in the suite
passed, because all of them imported from the source tree rather than from an
installed copy.

So this builds the real artifacts, installs the wheel somewhere with no repository
around it and no source directory on the path, and runs an envelope through it. It
also checks the sdist, because that is what a consumer on an unsupported platform
builds from.

Run: python packages/python/tools/consumer_smoke.py
"""

from __future__ import annotations

import subprocess
import sys
import tarfile
import tempfile
import venv
import zipfile
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]

# Everything the README promises. 0.0.1 shipped the first three and none of the rest.
REQUIRED_MODULES = ["__init__.py", "validate.py", "evaluate.py", "enforce.py", "cli.py"]

CONSUMER = r'''
import sys
from pathlib import Path

import intent_envelope
from intent_envelope import Call, EnforcementPoint, Refused, RunState, evaluate, validate

# Nothing may resolve from a source checkout. If it does, this proves nothing.
location = Path(intent_envelope.__file__).resolve()
assert "site-packages" in location.parts, f"imported from {location}, not an install"

envelope = {
    "intent_envelope": "0.1",
    "id": "invoice-reconciler",
    "revision": 3,
    "purpose": "Reconcile supplier invoices against the ledger and email a summary to the AP team.",
    "principal": {"agent_identity": "invoice-reconciler", "on_behalf_of": "finance.ap_team"},
    "tools": {
        "allow": [{"name": "send_email", "constraints": {"template": "summary"}}],
        "deny": ["issue_payment", "http_request"],
    },
    "recipients": {"allow": ["ap-team@example.com"], "max_per_run": 2},
    "limits": {"max_tool_calls": 10, "max_spend_usd": 2.0},
    "escalate": [{"when": "mismatch_value_gbp > 10000", "to": "ap-duty-controller", "timeout_seconds": 3600}],
    "on_no_response": "deny",
}

validate(envelope)

point = EnforcementPoint(envelope)

allowed = point.check("send_email", {"template": "summary", "to": "ap-team@example.com"})
assert allowed.result == "allow", allowed.result

exfil = point.check("send_email", {"template": "summary", "to": "collector@elsewhere.example"})
assert exfil.result == "deny" and exfil.rule == "recipients", (exfil.result, exfil.rule)

payment = point.check("issue_payment", {"amount": 24900})
assert payment.result == "deny" and payment.rule == "tools.deny", (payment.result, payment.rule)

assert point.summary() == {"allow": 1, "deny": 2, "escalate": 0}, point.summary()

# The guard must refuse before the tool is reached.
ran = []
guarded = point.guard(lambda name, args=None: ran.append(name))
try:
    guarded("issue_payment", {"amount": 1})
except Refused:
    pass
else:
    raise AssertionError("the guard let a denied call through")
assert ran == [], f"the refused call reached the tool anyway: {ran}"

# Note the asymmetry with the TypeScript package, which takes a plain object here.
# Python takes the dataclasses, which is what the conformance runner constructs too.
assert evaluate(envelope, Call(tool="issue_payment"), RunState()).rule == "tools.deny"

# The schema has to travel inside the package, since an install has no repo around it.
assert intent_envelope.load_schema()["$id"].endswith("intent-envelope/0.1.json")

# The CLI is an entry point, so it is installed separately from the module.
print(f"installed {intent_envelope.__version__}: validates, decides, refuses, ships its schema")
'''


def run(args: list[str], cwd: Path | None = None) -> str:
    done = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if done.returncode != 0:
        # A smoke test that hides the failure it found is worse than no smoke test.
        raise SystemExit(
            f"\n{' '.join(args[-2:])} failed with status {done.returncode}\n"
            f"{done.stdout}{done.stderr}"
        )
    return done.stdout


def contents(artifact: Path) -> set[str]:
    if artifact.suffix == ".whl":
        with zipfile.ZipFile(artifact) as z:
            return {Path(n).name for n in z.namelist()}
    with tarfile.open(artifact) as t:
        return {Path(n).name for n in t.getnames()}


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="intent-envelope-consumer-") as tmp:
        scratch = Path(tmp)
        dist = scratch / "dist"

        print("building sdist and wheel")
        run([sys.executable, "-m", "build", "--outdir", str(dist)], cwd=PKG)

        artifacts = sorted(dist.iterdir())
        if len(artifacts) != 2:
            print(f"expected an sdist and a wheel, got {[a.name for a in artifacts]}")
            return 1

        # Check both: a wheel is what most people install, an sdist is what the rest build.
        for artifact in artifacts:
            names = contents(artifact)
            missing = [m for m in REQUIRED_MODULES if m not in names]
            if missing:
                print(f"{artifact.name} is missing {missing}")
                return 1
            if "intent-envelope-0.1.json" not in names:
                print(f"{artifact.name} does not carry the schema")
                return 1
            print(f"{artifact.name}: every module and the schema are present")

        wheel = next(a for a in artifacts if a.suffix == ".whl")

        print("installing the wheel into a clean environment")
        env_dir = scratch / "venv"
        venv.create(env_dir, with_pip=True)
        # Windows puts executables in Scripts and adds .exe. Hardcoding bin/ is the
        # same mistake the TypeScript smoke test made by assuming npm was not a .cmd.
        windows = sys.platform == "win32"
        bindir = env_dir / ("Scripts" if windows else "bin")
        suffix = ".exe" if windows else ""
        python = bindir / f"python{suffix}"
        run([str(python), "-m", "pip", "install", "--quiet", str(wheel)])

        app = scratch / "consumer.py"
        app.write_text(CONSUMER, encoding="utf-8")
        # cwd is the scratch directory, so the repository is not importable from here.
        print(run([str(python), str(app)], cwd=scratch).strip())

        cli = run([str(bindir / f"intent-envelope{suffix}"), "--help"]).strip()
        if "validate" not in cli:
            print("the installed CLI does not offer validate")
            return 1
        print("the installed CLI works")

    return 0


if __name__ == "__main__":
    sys.exit(main())
