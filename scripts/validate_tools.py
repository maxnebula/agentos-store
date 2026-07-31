#!/usr/bin/env python3
"""Validate all tool definitions in tools/ against tool-schema.json.

Usage:
    python scripts/validate_tools.py
    python scripts/validate_tools.py tools/polymarket.json

Requires: pip install jsonschema
"""

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCHEMA_PATH = REPO / "tool-schema.json"


def load_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def validate_file(schema: dict, tool_path: Path) -> list[str]:
    try:
        import jsonschema
        from jsonschema import Draft7Validator
    except ImportError:
        print("error: 'jsonschema' is not installed. Run: pip install jsonschema")
        sys.exit(2)

    tool = load_json(tool_path)
    validator = Draft7Validator(schema)
    errors = sorted(validator.iter_errors(tool), key=lambda e: list(e.absolute_path))
    return [
        f"  {'.'.join(str(p) for p in e.absolute_path) or '(root)'}: {e.message}"
        for e in errors
    ]


def main() -> int:
    schema = load_json(SCHEMA_PATH)

    if len(sys.argv) > 1:
        files = [REPO / a for a in sys.argv[1:]]
    else:
        files = sorted((REPO / "tools").glob("*.json"))

    failed = False
    for path in files:
        errors = validate_file(schema, path)
        if errors:
            failed = True
            print(f"INVALID  {path.relative_to(REPO)}")
            print("\n".join(errors))
        else:
            print(f"ok       {path.relative_to(REPO)}")

    if failed:
        print("\nValidation failed.")
        return 1
    print("\nAll tool definitions are valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
