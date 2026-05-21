from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from s3browser.config import SEARCH_WHITELIST_ENV_VAR, get_search_whitelist_hosts
from s3browser.db import (
    delete_index_database,
    find_object_index_rows_by_keys,
    get_connection_by_id,
    get_or_create_indexed_bucket,
    mark_index_completed,
    sweep_stale_objects,
    upsert_object_index_batch,
)
from s3browser.s3 import create_s3_context_from_connection, get_effective_endpoint_host

MAX_CONTENT_BYTES = 2 * 1024 * 1024
DEFAULT_BATCH_SIZE = 1000
SLOW_FETCH_LOG_SECONDS = 1.0

TEXT_EXTENSIONS = {
    "txt",
    "md",
    "markdown",
    "rst",
    "json",
    "jsonc",
    "jsonl",
    "ndjson",
    "csv",
    "tsv",
    "log",
    "xml",
    "html",
    "htm",
    "yml",
    "yaml",
    "toml",
    "ini",
    "conf",
    "cfg",
    "env",
    "css",
    "scss",
    "less",
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "tsx",
    "vue",
    "svelte",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "sql",
    "tf",
    "hcl",
    "gitignore",
    "editorconfig",
    "lock",
}
TEXT_BASENAMES = {
    "readme",
    "license",
    "licence",
    "copying",
    "authors",
    "changelog",
    "makefile",
    "dockerfile",
    "jenkinsfile",
    "procfile",
}
TEXT_APP_TYPES = {
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/javascript",
    "application/ecmascript",
    "application/x-sh",
    "application/x-shellscript",
    "application/sql",
}


@dataclass
class PendingRow:
    input: dict[str, Any]
    needs_body_fetch: bool
    needs_head_check: bool


def _has_text_extension(key: str) -> bool:
    base = key.split("/")[-1]
    lower = base.lower()
    if lower in TEXT_BASENAMES:
        return True
    if "." not in lower:
        return False
    return lower.rsplit(".", 1)[1] in TEXT_EXTENSIONS


def _is_text_content_type(content_type: str | None) -> bool:
    if not content_type:
        return False
    lower = content_type.lower()
    return lower.startswith("text/") or any(lower.startswith(value) for value in TEXT_APP_TYPES)


def _timestamp_seconds(value: object) -> int:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return int(value.timestamp())
    raise RuntimeError("S3 ListObjectsV2 returned no LastModified")


def _head_is_text(client: Any, bucket: str, key: str) -> bool:
    head = client.head_object(Bucket=bucket, Key=key)
    return _is_text_content_type(head.get("ContentType"))


def _fetch_text_body(client: Any, bucket: str, key: str, max_bytes: int) -> str:
    response = client.get_object(Bucket=bucket, Key=key, Range=f"bytes=0-{max_bytes - 1}")
    body = response.get("Body")
    if body is None:
        raise RuntimeError("S3 returned no response body")
    try:
        data = body.read()
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()
    return bytes(data).decode("utf-8", errors="replace")


def index_s3_bucket(
    connection_id: int, bucket: str | None = None, batch_size: int = DEFAULT_BATCH_SIZE
) -> dict[str, int | float]:
    if connection_id <= 0:
        raise RuntimeError("Missing or invalid connectionId")
    if batch_size <= 0:
        raise RuntimeError("Invalid batchSize")
    connection = get_connection_by_id(connection_id)
    if connection is None:
        raise RuntimeError(f"Connection {connection_id} not found in DB")
    endpoint_host = get_effective_endpoint_host(connection.endpoint)
    if not endpoint_host or endpoint_host not in get_search_whitelist_hosts():
        if not endpoint_host:
            raise RuntimeError(
                f"Refusing to index: connection {connection.id} has no explicit endpoint set. "
                "Set the endpoint URL on the connection and add its host to "
                f"{SEARCH_WHITELIST_ENV_VAR}."
            )
        raise RuntimeError(
            f'Refusing to index: connection {connection.id} endpoint host "{endpoint_host}" '
            f"is not in {SEARCH_WHITELIST_ENV_VAR}."
        )
    effective_bucket = bucket or connection.bucket
    if not effective_bucket:
        raise RuntimeError("No bucket specified and connection has no default bucket")
    print(
        f"Indexing s3://{effective_bucket} for connection {connection.id} "
        f"({connection.profile_name}) at {endpoint_host}"
    )
    context = create_s3_context_from_connection(connection, effective_bucket)
    client = context.client
    indexed_bucket_id = get_or_create_indexed_bucket(endpoint_host, effective_bucket)
    run_started_at = int(time.time())
    start = time.time()
    totals: dict[str, int | float] = {
        "added": 0,
        "updated": 0,
        "touched": 0,
        "removed": 0,
        "seen": 0,
        "bodyFetched": 0,
        "bodySkippedUnchanged": 0,
        "bodySkippedNonText": 0,
        "bodySkippedSize": 0,
        "elapsedMs": 0,
    }
    continuation_token: str | None = None
    page_number = 0
    while True:
        params: dict[str, object] = {"Bucket": effective_bucket, "MaxKeys": batch_size}
        if continuation_token:
            params["ContinuationToken"] = continuation_token
        response = client.list_objects_v2(**params)
        page_number += 1
        contents = response.get("Contents", [])
        pending: list[PendingRow] = []
        for item in contents:
            key = item.get("Key")
            if not key:
                raise RuntimeError("S3 ListObjectsV2 returned a Contents row without a Key")
            size = item.get("Size")
            row_size = int(size) if size is not None else None
            needs_body_fetch = False
            needs_head_check = False
            if not str(key).endswith("/") and row_size != 0:
                if _has_text_extension(str(key)):
                    if row_size is not None and row_size > MAX_CONTENT_BYTES:
                        totals["bodySkippedSize"] = int(totals["bodySkippedSize"]) + 1
                    else:
                        needs_body_fetch = True
                elif row_size is None or row_size <= MAX_CONTENT_BYTES:
                    needs_head_check = True
            pending.append(
                PendingRow(
                    input={
                        "key": str(key),
                        "last_modified": _timestamp_seconds(item.get("LastModified")),
                        "size": row_size,
                        "content": None,
                    },
                    needs_body_fetch=needs_body_fetch,
                    needs_head_check=needs_head_check,
                )
            )
        totals["seen"] = int(totals["seen"]) + len(pending)
        existing = find_object_index_rows_by_keys(
            indexed_bucket_id, [str(row.input["key"]) for row in pending]
        )
        for row in pending:
            if not row.needs_body_fetch and not row.needs_head_check:
                continue
            prior_last_modified = existing.get(str(row.input["key"]))
            if prior_last_modified == int(row.input["last_modified"]):
                row.needs_body_fetch = False
                row.needs_head_check = False
                totals["bodySkippedUnchanged"] = int(totals["bodySkippedUnchanged"]) + 1
        for row in pending:
            key = str(row.input["key"])
            if row.needs_head_check:
                started = time.time()
                is_text = _head_is_text(client, effective_bucket, key)
                elapsed = time.time() - started
                if elapsed > SLOW_FETCH_LOG_SECONDS:
                    print(f"  slow HEAD {elapsed * 1000:.0f}ms key={key}")
                if is_text:
                    row.needs_body_fetch = True
                else:
                    totals["bodySkippedNonText"] = int(totals["bodySkippedNonText"]) + 1
                row.needs_head_check = False
            if row.needs_body_fetch:
                started = time.time()
                row.input["content"] = _fetch_text_body(
                    client, effective_bucket, key, MAX_CONTENT_BYTES
                )
                elapsed = time.time() - started
                if elapsed > SLOW_FETCH_LOG_SECONDS:
                    size = row.input["size"] or "?"
                    print(f"  slow GET {elapsed * 1000:.0f}ms key={key} size={size}")
                totals["bodyFetched"] = int(totals["bodyFetched"]) + 1
        result = upsert_object_index_batch(
            indexed_bucket_id, run_started_at, [row.input for row in pending]
        )
        for key in ("added", "updated", "touched"):
            totals[key] = int(totals[key]) + result[key]
        print(
            f"Page {page_number}: {totals['seen']} keys seen, "
            f"{totals['bodyFetched']} bodies fetched, elapsed {time.time() - start:.1f}s"
        )
        continuation_token = (
            response.get("NextContinuationToken") if response.get("IsTruncated") else None
        )
        if not continuation_token:
            break
    print(f"Sweeping stale index rows after {totals['seen']} indexed keys...")
    totals["removed"] = sweep_stale_objects(indexed_bucket_id, run_started_at)
    mark_index_completed(indexed_bucket_id, int(totals["seen"]))
    totals["elapsedMs"] = int((time.time() - start) * 1000)
    print(
        "Done. Indexed "
        f"{totals['seen']} keys (added={totals['added']}, updated={totals['updated']}, "
        f"touched={totals['touched']}, removed={totals['removed']}) in "
        f"{totals['elapsedMs'] / 1000:.1f}s"
    )
    print(
        f"Content: fetched={totals['bodyFetched']}, "
        f"skipped(unchanged)={totals['bodySkippedUnchanged']}, "
        f"skipped(non-text)={totals['bodySkippedNonText']}, "
        f"skipped(over-cap)={totals['bodySkippedSize']}"
    )
    return totals


def reset_index() -> None:
    print("Deleting and recreating the search index database...")
    delete_index_database()
    print("Search index database is empty.")
