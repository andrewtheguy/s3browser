from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_COUNT = 5000
DEFAULT_SUBFOLDER = "tmp/generated-files"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a batch of placeholder text files.")
    parser.add_argument("count", nargs="?", type=int, default=DEFAULT_COUNT)
    parser.add_argument("subfolder", nargs="?", default=DEFAULT_SUBFOLDER)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.count <= 0:
        print("Count must be a positive integer", file=sys.stderr)
        return 1

    subfolder = args.subfolder.strip() or DEFAULT_SUBFOLDER
    target_dir = Path.cwd() / subfolder
    target_dir.mkdir(parents=True, exist_ok=True)

    for i in range(1, args.count + 1):
        filename = f"file-{str(i).zfill(5)}.txt"
        (target_dir / filename).write_text(f"file {i}\n", encoding="utf-8")

    print(f"Created {args.count} files in {target_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
