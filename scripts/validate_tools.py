#!/usr/bin/env python3
"""Validate all store definitions against their JSON Schemas.

Usage:
    python scripts/validate_tools.py
    python scripts/validate_tools.py tools/polymarket.json skills/data_analyzer.json

Validates:
    tools/*.json   against tool-schema.json  (tools must have an HTTP/native surface)
    skills/*.json  against skill-schema.json (skills are prompt-only procedures)

Requires: pip install jsonschema
"""

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCHEMAS = {
    "tools": "tool-schema.json",
    "skills": "skill-schema.json",
}


def load_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def validate_file(schema: dict, item_path: Path) -> list[str]:
    try:
        import jsonschema
        from jsonschema import Draft7Validator
    except ImportError:
        print("error: 'jsonschema' is not installed. Run: pip install jsonschema")
        sys.exit(2)

    item = load_json(item_path)
    validator = Draft7Validator(schema)
    errors = sorted(validator.iter_errors(item), key=lambda e: list(e.absolute_path))
    return [
        f"  {'.'.join(str(p) for p in e.absolute_path) or '(root)'}: {e.message}"
        for e in errors
    ]


def main() -> int:
    if len(sys.argv) > 1:
        targets = [REPO / a for a in sys.argv[1:]]
        by_dir = {d: [p for p in targets if p.parent.name == d] for d in SCHEMAS}
        if any(p.parent.name not in SCHEMAS for p in targets):
            print(f"error: unknown item directory (expected one of {list(SCHEMAS)})")
            return 2
    else:
        by_dir = {d: sorted((REPO / d).glob("*.json")) for d in SCHEMAS}

    failed = False
    for dir_name, schema_file in SCHEMAS.items():
        schema = load_json(REPO / schema_file)
        files = by_dir.get(dir_name, [])
        print(f"[{dir_name}]")
        for path in files:
            errors = validate_file(schema, path)
            if errors:
                failed = True
                print(f"  INVALID  {path.relative_to(REPO)}")
                print("\n".join(errors))
            else:
                print(f"  ok       {path.relative_to(REPO)}")

    if failed:
        print("\nValidation failed.")
        return 1
    print("\nAll store definitions are valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
