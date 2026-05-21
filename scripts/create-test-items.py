from __future__ import annotations

import argparse
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
from botocore.config import Config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create empty test items in an S3 bucket.")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", default="")
    parser.add_argument("--count", type=int, default=10005)
    parser.add_argument("--region", default=None)
    parser.add_argument("--endpoint", default=None)
    parser.add_argument("--concurrency", type=int, default=25)
    parser.add_argument("--force-path-style", action="store_true", dest="force_path_style")
    return parser.parse_args()


def normalize_prefix(prefix: str) -> str:
    if not prefix:
        return ""
    return prefix if prefix.endswith("/") else f"{prefix}/"


def main() -> int:
    args = parse_args()

    if args.count <= 0:
        print("Invalid --count value", file=sys.stderr)
        return 1
    if args.concurrency <= 0:
        print("Invalid --concurrency value", file=sys.stderr)
        return 1

    prefix = normalize_prefix(args.prefix)
    width = len(str(args.count))
    total = args.count

    s3_config = Config(
        s3={"addressing_style": "path"} if args.force_path_style else {},
        max_pool_connections=max(args.concurrency, 10),
    )
    client = boto3.client(
        "s3",
        region_name=args.region,
        endpoint_url=args.endpoint,
        config=s3_config,
    )

    completed = 0
    lock = threading.Lock()

    def upload_one(index: int) -> None:
        nonlocal completed
        key = f"{prefix}item-{str(index + 1).zfill(width)}.txt"
        client.put_object(Bucket=args.bucket, Key=key, Body=b"", ContentType="text/plain")
        with lock:
            completed += 1
            if completed % 500 == 0 or completed == total:
                print(f"Uploaded {completed}/{total}")

    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = [executor.submit(upload_one, i) for i in range(total)]
        for future in as_completed(futures):
            future.result()

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Failed to create test items: {error}", file=sys.stderr)
        sys.exit(1)
