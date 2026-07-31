#!/usr/bin/env python3
"""Build game bundles for the AgentOS store.

For every games/<id>/ package:
    1. Validate game.json against game-schema.json (fail hard).
    2. Cross-check structure (entry exists, block refs, sea level, textures).
    3. Zip bundle/ into dist/games/<id>/bundle.zip (deterministic ordering).
    4. Write assets {url, sha256, size} and a human size label back into game.json.
    5. Re-validate the updated manifest.

Usage:
    python scripts/build_games.py                  # build every game
    python scripts/build_games.py voxel_world      # build one game
    python scripts/build_games.py --check          # validate only (no writes); CI gate

The committed game.json is always self-consistent: build_games.py is the only
writer of the assets field. dist/ is gitignored; the zip is served from
raw.githubusercontent.com exactly like every other store file.
"""

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GAME_DIR = REPO / "games"
DIST_DIR = REPO / "dist"
DIST_URL_BASE = "https://raw.githubusercontent.com/maxnebula/agentos-store/main/dist/games"
SCHEMA = REPO / "game-schema.json"

sys.path.insert(0, str(REPO / "scripts"))
from validate_tools import (  # noqa: E402
    check_game_bundle,
    check_game_integrity,
    check_game_source,
    load_json,
    validate_file,
)


def human_size(num: int) -> str:
    for unit in ("B", "KB", "MB"):
        if num < 1024 or unit == "MB":
            return f"{num:.0f} {unit}" if unit == "B" else f"{num:.0f} {unit}"
        num /= 1024
    return f"{num:.0f} GB"


def build_bundle(game_dir: Path, schema: dict) -> list[str]:
    errors: list[str] = []
    manifest_path = game_dir / "game.json"
    bundle_dir = game_dir / "bundle"

    errors += validate_file(schema, manifest_path)
    errors += check_game_source(game_dir)
    if errors:
        return errors

    if not bundle_dir.is_dir():
        return [f"  bundle/: missing directory {bundle_dir.relative_to(REPO)}"]

    out_zip = DIST_DIR / "games" / game_dir.name / "bundle.zip"
    out_zip.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(bundle_dir.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(bundle_dir).as_posix())

    manifest = load_json(manifest_path)
    manifest["assets"] = {
        "url": f"{DIST_URL_BASE}/{game_dir.name}/bundle.zip",
        "sha256": hashlib.sha256(out_zip.read_bytes()).hexdigest(),
        "size": out_zip.stat().st_size,
    }
    manifest["size"] = human_size(out_zip.stat().st_size)

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=True)
        f.write("\n")

    errors += validate_file(schema, manifest_path)
    errors += check_game_integrity(manifest_path)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Build AgentOS game bundles")
    parser.add_argument("games", nargs="*", help="game ids to build (default: all)")
    parser.add_argument("--check", action="store_true", help="validate only, do not write")
    args = parser.parse_args()

    schema = load_json(SCHEMA)
    ids = args.games or [d.name for d in sorted(GAME_DIR.iterdir()) if d.is_dir()]
    ids = [i for i in ids if (GAME_DIR / i / "game.json").is_file()]

    if not ids:
        print("No game packages found under games/.")
        return 0

    failed = False
    for game_id in ids:
        game_dir = GAME_DIR / game_id
        print(f"[{game_id}]")
        if args.check:
            errors = validate_file(schema, game_dir / "game.json")
            errors += check_game_integrity(game_dir / "game.json")
        else:
            errors = build_bundle(game_dir, schema)
        if errors:
            failed = True
            print(f"  INVALID  {game_dir.relative_to(REPO)}")
            print("\n".join(errors))
        else:
            what = "valid" if args.check else "built"
            print(f"  ok       {game_id} ({what})")

    if failed:
        print("\nBuild failed.")
        return 1
    print("\nAll game packages are valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
