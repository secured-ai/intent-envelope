"""Command line entry point: intent-envelope validate <file>..."""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from . import __version__
from .validate import SPEC_VERSION, ValidationError, validate_file


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="intent-envelope",
        description="Validate intent envelopes against the published schema.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__} (spec {SPEC_VERSION})")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("validate", help="validate one or more envelope files")
    check.add_argument("files", nargs="+", metavar="FILE")

    args = parser.parse_args(argv)
    failed = 0
    for path in args.files:
        try:
            validate_file(path)
        except FileNotFoundError:
            print(f"{path}: no such file", file=sys.stderr)
            failed += 1
        except ValidationError as exc:
            print(f"{path}: invalid", file=sys.stderr)
            for problem in exc.problems:
                print(f"  {problem}", file=sys.stderr)
            failed += 1
        else:
            print(f"{path}: valid")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
