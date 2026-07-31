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
    bundle_dir = game_dir / "bundle"

    entry = game.get("entry")
    if entry and not (bundle_dir / entry).is_file():
        errors.append(f"  entry: '{entry}' not found inside bundle/")

    if not bundle_dir.is_dir():
        errors.append(f"  bundle/: missing directory {bundle_dir.relative_to(REPO)}")
        return errors

    world = game.get("world")
    if not world:
        return errors

    block_ids = {b.get("id") for b in world.get("blocks", [])}
    missing = lambda refs: sorted(ref for ref in refs if ref not in block_ids)

    for ref_name, refs in (
        ("hotbar", world.get("hotbar", [])),
        ("worldgen.trees.block", [world.get("worldgen", {}).get("trees", {}).get("block")]),
        ("worldgen.trees.leafBlock", [world.get("worldgen", {}).get("trees", {}).get("leafBlock")]),
        ("worldgen.ore[*].block", [o.get("block") for o in world.get("worldgen", {}).get("ore", [])]),
    ):
        bad = missing(r for r in refs if r)
        if bad:
            errors.append(f"  world.{ref_name}: unknown block id(s): {', '.join(bad)}")

    for i, biome in enumerate(world.get("worldgen", {}).get("biomes", [])):
        bad = missing([biome.get("surface"), biome.get("sub")])
        if bad:
            errors.append(f"  world.worldgen.biomes[{i}]: unknown block id(s): {', '.join(bad)}")

    height = world.get("size", {}).get("cy")
    sea_level = world.get("worldgen", {}).get("seaLevel")
    if height and sea_level is not None and not (0 <= sea_level < height):
        errors.append(f"  world.worldgen.seaLevel {sea_level} outside world height 0..{height - 1}")

    if world.get("blocks"):
        tex_dir = bundle_dir / "textures"
        tex_files = sorted(tex_dir.glob("tile_*.png")) if tex_dir.is_dir() else []
        tile_count = len(tex_files)
        max_tile = max((b.get("tile", 0) for b in world["blocks"]), default=0)
        if tile_count and max_tile >= tile_count:
            errors.append(
                f"  world.blocks: tile index {max_tile} out of range (bundle has {tile_count} textures)"
            )

    return errors


def check_game_bundle(game_dir: Path) -> list[str]:
    """Integrity checks against the built bundle zip and the committed assets field."""
    errors: list[str] = []
    game = load_json(game_dir / "game.json")
    bundle_zip = REPO / "dist" / "games" / game_dir.name / "bundle.zip"

    if not bundle_zip.is_file():
        errors.append(
            f"  assets: no built bundle at {bundle_zip.relative_to(REPO)} "
            "— run scripts/build_games.py"
        )
        return errors

    entry = game.get("entry")
    if entry:
        with zipfile.ZipFile(bundle_zip) as zf:
            if entry not in zf.namelist():
                errors.append(f"  entry: '{entry}' not found inside bundle.zip")

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
    return check_game_source(item_path.parent) + check_game_bundle(item_path.parent)


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
