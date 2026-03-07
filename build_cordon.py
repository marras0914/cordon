"""
build_cordon.py — Cordon MCP Security Gateway packager

Packages the cordon_gateway/ directory into a distributable zip,
excluding development artifacts (tests, caches, local DB files).

Usage:
    python build_cordon.py                  # creates cordon_gateway_<version>.zip
    python build_cordon.py --version 1.2.3  # override version tag
    python build_cordon.py --output dist/   # set output directory
"""

import argparse
import os
import zipfile
from pathlib import Path

# Files and directories to exclude from the package
EXCLUDE_DIRS = {
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".git", "node_modules",
}
EXCLUDE_FILES = {
    "cordon_audit.db", "gemini-convo.MD",
    ".env",
}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".db-shm", ".db-wal"}

VERSION = "0.1.0"
SOURCE_DIR = Path(__file__).parent / "cordon_gateway"


def should_exclude(path: Path) -> bool:
    if path.name in EXCLUDE_FILES:
        return True
    if path.suffix in EXCLUDE_SUFFIXES:
        return True
    for part in path.parts:
        if part in EXCLUDE_DIRS:
            return True
    # Exclude .env files (but keep .env.example)
    if path.name.startswith(".env") and path.name != ".env.example":
        return True
    return False


def build(version: str, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    zip_path = output_dir / f"cordon_gateway_{version}.zip"

    file_count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for abs_path in sorted(SOURCE_DIR.rglob("*")):
            if not abs_path.is_file():
                continue
            rel = abs_path.relative_to(SOURCE_DIR.parent)
            if should_exclude(rel):
                continue
            zf.write(abs_path, arcname=rel)
            file_count += 1
            print(f"  + {rel}")

    return zip_path, file_count


def main():
    parser = argparse.ArgumentParser(description="Package Cordon for distribution")
    parser.add_argument("--version", default=VERSION, help="Version tag (default: %(default)s)")
    parser.add_argument("--output", default=".", help="Output directory (default: current dir)")
    args = parser.parse_args()

    print(f"Building Cordon {args.version} from {SOURCE_DIR}")
    print()

    zip_path, file_count = build(args.version, Path(args.output))

    print()
    print(f"Packaged {file_count} files -> {zip_path}")
    print()
    print("Quick start:")
    print(f"  unzip {zip_path.name}")
    print("  cd cordon_gateway")
    print("  cp .env.example .env   # fill in secrets")
    print("  docker compose up --build")


if __name__ == "__main__":
    main()
