"""One-time script to upload a test file with custom metadata to Backblaze B2.

Run with: uv run python scripts/upload-test-metadata.py
"""

from __future__ import annotations

import base64
import sqlite3
import sys
from datetime import UTC, datetime

import boto3

from s3browser.crypto import decrypt, set_salt
from s3browser.paths import DB_PATH


def fetch_salt(conn: sqlite3.Connection) -> bytes:
    row = conn.execute("SELECT value FROM metadata WHERE key = 'encryption_salt'").fetchone()
    if row is None:
        raise RuntimeError("Salt not found in database")
    return base64.b64decode(row["value"])


def fetch_backblaze_connection(conn: sqlite3.Connection) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT id, profile_name, endpoint, access_key_id, secret_access_key, bucket, region
        FROM s3_connections
        WHERE profile_name LIKE '%backblaze%' OR endpoint LIKE '%backblaze%'
        """
    ).fetchone()
    if row is None:
        raise RuntimeError("Backblaze connection not found")
    return row


def main() -> int:
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        set_salt(fetch_salt(conn))
        connection = fetch_backblaze_connection(conn)
    finally:
        conn.close()

    print(f"Found connection: {connection['profile_name']}")
    print(f"Endpoint: {connection['endpoint']}")
    print(f"Bucket: {connection['bucket'] or 'not set'}")

    secret_access_key = decrypt(connection["secret_access_key"])

    client = boto3.client(
        "s3",
        endpoint_url=connection["endpoint"],
        region_name=connection["region"] or "us-west-004",
        aws_access_key_id=connection["access_key_id"],
        aws_secret_access_key=secret_access_key,
    )

    bucket = "andrewtheguy-data"
    key = "test-metadata-file.txt"
    content = f"This is a test file with custom metadata.\nCreated: {datetime.now(UTC).isoformat()}"

    print("\nUploading file with metadata...")
    print(f"  Bucket: {bucket}")
    print(f"  Key: {key}")
    print("  Cache-Control: max-age=3600")
    print('  Content-Disposition: inline; filename="test-file.txt"')
    print("  Content-Encoding: identity")
    print("  Custom Metadata:")
    print("    custom-key-1: custom-value-1")
    print("    author: claude-test-script")
    print("    purpose: testing-metadata-display")

    try:
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=content.encode("utf-8"),
            ContentType="text/plain",
            CacheControl="max-age=3600",
            ContentDisposition='inline; filename="test-file.txt"',
            ContentEncoding="identity",
            Metadata={
                "custom-key-1": "custom-value-1",
                "author": "claude-test-script",
                "purpose": "testing-metadata-display",
            },
        )
    except Exception as error:
        print(f"\nUpload failed: {error}", file=sys.stderr)
        return 1

    print("\nUpload successful!")
    print("\nYou can now view the file details in the S3 Browser app to verify the metadata.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
