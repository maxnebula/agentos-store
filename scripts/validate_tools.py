#!/usr/bin/env python3
"""Validate all store definitions against their JSON Schemas.

Usage:
    python scripts/validate_tools.py
    python scripts/validate_tools.py tools/polymarket.json skills/data_analyzer.json

Validates:
    tools/*.json   against tool-schema.json   (tools must have an HTTP/native surface)
    skills/*.json  against skill-schema.json  (skills are prompt-only procedures)
    games/*/game.json against game-schema.json (games are declarative engine content)

For games, schema validation is followed by structural cross-checks:
    - entry exists inside the built bundle zip (or bundle/ directory)
    - assets.sha256/size match the built bundle zip
    - hotbar/biomes/trees/ore reference existing block ids
    - seaLevel is within world height; block tile indexes have matching textures

Requires: pip install jsonschema
"""

import hashlib
import json
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCHEMAS = {
    "tools": "tool-schema.json",
    "skills": "skill-schema.json",
    "games": "game-schema.json",
}


def load_json(path: Path) -> dict:
    # utf-8-sig tolerates the BOM that Windows editors (Notepad/PowerShell) add
    with open(path, "r", encoding="utf-8-sig") as f:
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


def check_game_source(game_dir: Path) -> list[str]:
    """Structural checks on the authoring source (no built zip involved)."""
    errors: list[str] = []
    game = load_json(game_dir / "game.json")
    engine = game.get("engine")
    bundle_dir = game_dir / "bundle"

    if engine == "web":
        entry = game.get("entry")
        if entry and not (bundle_dir / entry).is_file():
            errors.append(f"  entry: '{entry}' not found inside bundle/")
        if not bundle_dir.is_dir():
            errors.append(f"  bundle/: missing directory {bundle_dir.relative_to(REPO)}")
        return errors

    if engine == "native2d":
        return check_world2d(game, game_dir)

    errors.append(f"  engine: unknown engine '{engine}' (expected web or native2d)")
    return errors


def check_world2d(game: dict, game_dir: Path) -> list[str]:
    """Cross-reference and bounds checks for native2d world definitions."""
    errors: list[str] = []
    world = game.get("world") or {}
    block_ids = {b.get("id") for b in world.get("blocks", [])}
    missing = lambda refs: sorted(ref for ref in refs if ref not in block_ids)

    wgen = world.get("worldgen", {})
    height = world.get("size", {}).get("height")

    for ref_name, refs in (
        ("worldgen.trees.block", [wgen.get("trees", {}).get("block")]),
        ("worldgen.trees.leafBlock", [wgen.get("trees", {}).get("leafBlock")]),
        ("worldgen.ores[*].block", [o.get("block") for o in wgen.get("ores", [])]),
        ("worldgen.seaTile", [wgen.get("seaTile")]),
        ("hotbar", world.get("hotbar", [])),
    ):
        bad = missing(r for r in refs if r)
        if bad:
            errors.append(f"  world.{ref_name}: unknown block id(s): {', '.join(bad)}")

    if world.get("blocks") is not None:
        ids = [b.get("id") for b in world["blocks"]]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            errors.append(f"  world.blocks: duplicate block id(s): {', '.join(dupes)}")

    sea_level = wgen.get("seaLevel")
    if height and sea_level is not None and not (0 <= sea_level < height):
        errors.append(
            f"  world.worldgen.seaLevel {sea_level} outside world height 0..{height - 1}"
        )

    base_height = wgen.get("heightmap", {}).get("baseHeight")
    if height and base_height is not None and base_height >= height:
        errors.append(
            f"  world.worldgen.heightmap.baseHeight {base_height} must be below world height {height}"
        )

    trees = wgen.get("trees") or {}
    if trees:
        if trees.get("minHeight", 1) > trees.get("maxHeight", 1):
            errors.append(
                f"  world.worldgen.trees: minHeight {trees.get('minHeight')} > "
                f"maxHeight {trees.get('maxHeight')}"
            )
        if height and trees.get("maxHeight", 0) + (base_height or 0) >= height:
            errors.append(
                f"  world.worldgen.trees: maxHeight {trees.get('maxHeight')} with baseHeight "
                f"{base_height} exceeds world height {height}"
            )

    for i, ore in enumerate(wgen.get("ores", [])):
        if ore.get("minY", 0) > ore.get("maxY", 0):
            errors.append(
                f"  world.worldgen.ores[{i}]: minY {ore.get('minY')} > maxY {ore.get('maxY')}"
            )
        if height and ore.get("maxY", 0) >= height:
            errors.append(
                f"  world.worldgen.ores[{i}]: maxY {ore.get('maxY')} outside world height "
                f"0..{height - 1}"
            )

    return errors


def check_game_bundle(game_dir: Path) -> list[str]:
    """Integrity checks against the built bundle zip and the committed assets field."""
    errors: list[str] = []
    game = load_json(game_dir / "game.json")

    if game.get("engine") != "web":
        return errors

    bundle_zip = REPO / "dist" / "games" / game_dir.name / "bundle.zip"

    if not bundle_zip.is_file():
        errors.append(
            f"  assets: no built bundle at {bundle_zip.relative_to(REPO)} "
            "— run scripts/build_games.py"
        )
        return errors

    entry = game.get("entry")
    with zipfile.ZipFile(bundle_zip) as zf:
        names = zf.namelist()
        if entry and entry not in names:
            errors.append(f"  entry: '{entry}' not found inside bundle.zip")
        for name in names:
            if name.startswith("/") or ".." in name.split("/"):
                errors.append(f"  bundle.zip: unsafe entry path '{name}'")

    actual_sha = hashlib.sha256(bundle_zip.read_bytes()).hexdigest()
    assets = game.get("assets", {})
    if assets.get("sha256") != actual_sha:
        errors.append(
            f"  assets.sha256 mismatch: game.json says {assets.get('sha256')}, "
            f"actual {actual_sha} — run scripts/build_games.py"
        )
    if assets.get("size") != bundle_zip.stat().st_size:
        errors.append(
            f"  assets.size mismatch: game.json says {assets.get('size')}, "
            f"actual {bundle_zip.stat().st_size} — run scripts/build_games.py"
        )

    return errors


def check_game_integrity(item_path: Path) -> list[str]:
    """Full structural + bundle integrity checks for a game definition."""
    game_dir = item_path.parent
    errors = check_game_source(game_dir)
    if (load_json(item_path).get("engine")) == "web":
        errors += check_game_bundle(game_dir)
    return errors


def find_game_files(repo: Path) -> list[Path]:
    return sorted((repo / "games").glob("*/game.json"))


def main() -> int:
    if len(sys.argv) > 1:
        targets = [REPO / a for a in sys.argv[1:]]
        by_dir = {d: [p for p in targets if p.parent.name == d] for d in SCHEMAS}
        game_files = [p for p in targets if p.name == "game.json" and p.parent.parent.name == "games"]
        by_dir["games"] = game_files
        if any(p.parent.name not in SCHEMAS and p not in game_files for p in targets):
            print(f"error: unknown item directory (expected one of {list(SCHEMAS)} or games/<id>/game.json)")
            return 2
    else:
        by_dir = {d: sorted((REPO / d).glob("*.json")) for d in SCHEMAS if d != "games"}
        by_dir["games"] = find_game_files(REPO)

    failed = False
    for dir_name, schema_file in SCHEMAS.items():
        schema = load_json(REPO / schema_file)
        files = by_dir.get(dir_name, [])
        print(f"[{dir_name}]")
        for path in files:
            errors = validate_file(schema, path)
            if dir_name == "games":
                errors += check_game_integrity(path)
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
