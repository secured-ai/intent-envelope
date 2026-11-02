"""What gets published has to match what the repository says it is.

These are the checks that would have caught the 0.0.1 release, which went to PyPI
carrying only the validator while the README documented an enforcement point. Anyone
following the README after installing it got an ImportError. A test suite that only
ever runs against the source tree cannot see that, because nothing in it imports the
package the way a person who ran `pip install` does.
"""

import re
from pathlib import Path

import pytest

import intent_envelope

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def declared_version() -> str:
    """The version pip will record, read from the file the build backend reads."""
    # tomllib is 3.11+, and this package supports 3.9, so fall back to a narrow regex
    # rather than taking a dependency for one field.
    text = PYPROJECT.read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match, "no version found in pyproject.toml"
    return match.group(1)


def test_module_version_matches_pyproject():
    # Two places holding the same number is two places to forget. __init__ said 0.1.0
    # while pyproject said 0.0.1, which would have failed the release workflow's tag
    # check while the installed package reported a version that was never published.
    assert intent_envelope.__version__ == declared_version()


def test_installed_metadata_matches_the_module():
    # The version pip records comes from the built metadata, not from __init__. If the
    # two disagree, `pip show` and `intent_envelope.__version__` tell different stories
    # and an audit trail citing either one is unreliable.
    from importlib.metadata import PackageNotFoundError, version

    try:
        installed = version("intent-envelope")
    except PackageNotFoundError:
        pytest.skip("package is not installed; run against an installed copy")
    assert installed == intent_envelope.__version__


@pytest.mark.parametrize(
    "name",
    [
        # The envelope half.
        "validate",
        "load_schema",
        "ValidationError",
        # The decision half, absent from 0.0.1 despite being in the README.
        "evaluate",
        "Call",
        "RunState",
        "Decision",
        "UnsupportedCondition",
        # The enforcement half, likewise absent.
        "EnforcementPoint",
        "Refused",
        "Escalated",
        "default_facts",
    ],
)
def test_public_name_is_importable(name):
    """Everything __all__ promises must actually import from the package root."""
    assert hasattr(intent_envelope, name), f"intent_envelope.{name} is missing"
    assert name in intent_envelope.__all__, f"{name} imports but is not in __all__"


def test_all_names_resolve():
    """And nothing in __all__ may be a name that does not exist."""
    missing = [n for n in intent_envelope.__all__ if not hasattr(intent_envelope, n)]
    assert not missing, f"__all__ promises names the package does not have: {missing}"


def test_the_schema_ships_inside_the_package():
    # The package must not reach outside its own directory for the schema, because an
    # installed copy has no repository around it.
    schema = Path(intent_envelope.__file__).parent / "schema" / "intent-envelope-0.1.json"
    assert schema.is_file(), "the schema is not inside the installed package"
    assert intent_envelope.load_schema()["$id"].endswith("intent-envelope/0.1.json")
