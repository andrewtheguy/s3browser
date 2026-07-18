from __future__ import annotations

import secrets
import time
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from datetime import UTC, datetime
from inspect import isawaitable
from stat import S_IFREG
from typing import Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from stream_zip import ZIP_64, async_stream_zip

from s3browser.dependencies import get_s3_context
from s3browser.s3 import S3Context, is_access_denied, is_not_found, require_bucket
from s3browser.utils import (
    build_content_disposition,
    extract_file_name,
    sanitize_filename,
    sanitize_version_id,
    validate_content_type,
    validate_object_key,
)

router = APIRouter(prefix="/api/download", tags=["download"])
STREAM_CHUNK_SIZE = 64 * 1024

# Maximum number of objects that may be bundled into a single ZIP. Folder
# downloads can far exceed the delete path's cap, so this is deliberately large.
MAX_ZIP_ENTRIES = 10000
# How long a batch-zip ticket stays valid after creation.
ZIP_TICKET_TTL_SECONDS = 5 * 60
# Upper bound on outstanding tickets; caps memory under repeated ticket creation.
MAX_ZIP_TICKETS = 256
# Reserved archive path used for the best-effort failure manifest. User objects
# may not claim this name, or a failure could collide with it in the ZIP.
ERROR_MANIFEST_NAME = "_download-errors.txt"


class ZipEntry(BaseModel):
    key: str
    versionId: str | None = None
    name: str


class BatchZipTicketRequest(BaseModel):
    entries: list[ZipEntry] | None = None
    archiveName: str | None = None


@dataclass(frozen=True)
class _ResolvedZipEntry:
    key: str
    version_id: str | None
    name: str


@dataclass(frozen=True)
class _ZipTicket:
    connection_id: int
    bucket: str
    entries: list[_ResolvedZipEntry]
    archive_name: str
    expires_at: float


# In-process store of pending batch-zip downloads. This assumes a single uvicorn
# worker; a multi-worker deployment would need a shared store (e.g. Redis).
_ZIP_TICKETS: dict[str, _ZipTicket] = {}


def _prune_expired_tickets(now: float) -> None:
    expired = [token for token, ticket in _ZIP_TICKETS.items() if ticket.expires_at <= now]
    for token in expired:
        _ZIP_TICKETS.pop(token, None)
    # Enforce the quota by evicting the tickets closest to expiry, leaving room
    # for one fresh insertion while keeping the freshest valid tickets intact.
    while len(_ZIP_TICKETS) >= MAX_ZIP_TICKETS:
        oldest = min(_ZIP_TICKETS, key=lambda token: _ZIP_TICKETS[token].expires_at)
        _ZIP_TICKETS.pop(oldest, None)


def _validate_zip_entry_name(name: object) -> str:
    if not isinstance(name, str) or not name:
        raise HTTPException(status_code=400, detail="Archive entry name is required")
    if name.startswith("/"):
        raise HTTPException(status_code=400, detail="Archive entry name must be relative")
    segments = name.split("/")
    if any(segment in ("", "..", ".") for segment in segments):
        raise HTTPException(status_code=400, detail="Invalid archive entry name")
    if any(ord(char) <= 0x1F or ord(char) == 0x7F or char == "\\" for char in name):
        raise HTTPException(status_code=400, detail="Invalid character in archive entry name")
    if name == ERROR_MANIFEST_NAME:
        raise HTTPException(status_code=400, detail=f"Reserved archive entry name: {name}")
    if len(name.encode("utf-8")) > 1024:
        raise HTTPException(status_code=400, detail="Archive entry name exceeds 1024 bytes")
    return name


@router.get("/{connection_id}/{bucket}/url")
async def presigned_url(
    request: Request,
    context: S3Context = Depends(get_s3_context),
) -> dict[str, str]:
    bucket = require_bucket(context)
    key = validate_object_key(request.query_params.get("key"))
    version_id = sanitize_version_id(request.query_params.get("versionId"))
    ttl = 3600
    raw_ttl = request.query_params.get("ttl")
    if raw_ttl is not None:
        try:
            parsed = int(raw_ttl)
        except ValueError as error:
            raise HTTPException(
                status_code=400, detail="TTL must be between 60 and 604800 seconds"
            ) from error
        if parsed < 60 or parsed > 604800:
            raise HTTPException(status_code=400, detail="TTL must be between 60 and 604800 seconds")
        ttl = parsed
    disposition = request.query_params.get("disposition")
    content_type = validate_content_type(request.query_params.get("contentType"))
    filename = extract_file_name(key) or "download"
    params: dict[str, object] = {"Bucket": bucket, "Key": key}
    if version_id:
        params["VersionId"] = version_id
    if disposition == "inline":
        params["ResponseContentDisposition"] = "inline"
    elif disposition == "attachment":
        params["ResponseContentDisposition"] = build_content_disposition("attachment", filename)
    if content_type:
        params["ResponseContentType"] = content_type
    try:
        url = await context.client.generate_presigned_url(
            "get_object", Params=params, ExpiresIn=ttl
        )
    except Exception as error:
        print(f"Failed to generate presigned URL: {error}")
        raise HTTPException(status_code=500, detail="Failed to generate presigned URL") from error
    return {"url": url}


async def _await_if_needed(result: object) -> None:
    if isawaitable(result):
        await cast(Awaitable[object], result)


async def _call_body_callback(body: Any, name: str) -> bool:
    callback = getattr(body, name, None)
    if not callable(callback):
        return False
    await _await_if_needed(callback())
    return True


async def _release_body(body: Any) -> None:
    if await _call_body_callback(body, "release"):
        await _call_body_callback(body, "wait_for_close")
        return
    await _call_body_callback(body, "close")


async def _iter_body(body: Any) -> AsyncIterator[bytes]:
    try:
        while True:
            chunk = await body.read(STREAM_CHUNK_SIZE)
            if not chunk:
                break
            yield chunk
    finally:
        await _release_body(body)


@router.get("/{connection_id}/{bucket}/object")
async def download_object(
    request: Request,
    range_header: str | None = Header(default=None, alias="Range"),
    context: S3Context = Depends(get_s3_context),
) -> StreamingResponse:
    bucket = require_bucket(context)
    key = validate_object_key(request.query_params.get("key"))
    version_id = sanitize_version_id(request.query_params.get("versionId"))
    disposition = "inline" if request.query_params.get("disposition") == "inline" else "attachment"
    content_type_override = validate_content_type(request.query_params.get("contentType"))
    params: dict[str, object] = {"Bucket": bucket, "Key": key}
    if version_id:
        params["VersionId"] = version_id
    if range_header:
        params["Range"] = range_header
    try:
        response = await context.client.get_object(**params)
    except Exception as error:
        if is_access_denied(error):
            raise HTTPException(status_code=403, detail="Access denied") from error
        if is_not_found(error):
            raise HTTPException(status_code=404, detail="Object not found") from error
        print(f"Failed to stream object: {error}")
        raise HTTPException(status_code=500, detail="Failed to stream object") from error
    body = response.get("Body")
    if body is None:
        raise HTTPException(status_code=500, detail="Missing response body")
    filename = extract_file_name(key) or "download"
    headers: dict[str, str] = {
        "Content-Disposition": "inline"
        if disposition == "inline"
        else build_content_disposition("attachment", filename),
        "Content-Type": content_type_override
        or response.get("ContentType")
        or "application/octet-stream",
        "Accept-Ranges": response.get("AcceptRanges") or "bytes",
    }
    if response.get("ContentLength") is not None:
        headers["Content-Length"] = str(response["ContentLength"])
    if response.get("ContentRange"):
        headers["Content-Range"] = response["ContentRange"]
    return StreamingResponse(
        _iter_body(body),
        status_code=206 if response.get("ContentRange") else 200,
        headers=headers,
        media_type=headers["Content-Type"],
    )


@router.post("/{connection_id}/{bucket}/batch-zip-ticket")
async def create_batch_zip_ticket(
    payload: BatchZipTicketRequest,
    context: S3Context = Depends(get_s3_context),
) -> dict[str, str]:
    bucket = require_bucket(context)
    raw_entries = payload.entries or []
    if not raw_entries:
        raise HTTPException(status_code=400, detail="No objects to download")
    if len(raw_entries) > MAX_ZIP_ENTRIES:
        raise HTTPException(
            status_code=400,
            detail=f"Too many objects: limit is {MAX_ZIP_ENTRIES}",
        )

    resolved: list[_ResolvedZipEntry] = []
    seen_names: set[str] = set()
    for entry in raw_entries:
        key = validate_object_key(entry.key)
        name = _validate_zip_entry_name(entry.name)
        # Duplicate archive paths would produce an ambiguous ZIP; reject early.
        if name in seen_names:
            raise HTTPException(status_code=400, detail=f"Duplicate archive entry name: {name}")
        seen_names.add(name)
        resolved.append(
            _ResolvedZipEntry(
                key=key,
                version_id=sanitize_version_id(entry.versionId),
                name=name,
            )
        )

    archive_name = sanitize_filename(payload.archiveName or "download.zip")
    if not archive_name.lower().endswith(".zip"):
        archive_name = f"{archive_name}.zip"

    now = time.monotonic()
    _prune_expired_tickets(now)
    token = secrets.token_urlsafe(32)
    _ZIP_TICKETS[token] = _ZipTicket(
        connection_id=context.connection_id,
        bucket=bucket,
        entries=resolved,
        archive_name=archive_name,
        expires_at=now + ZIP_TICKET_TTL_SECONDS,
    )
    return {"ticket": token}


async def _member_data(body: Any) -> AsyncIterator[bytes]:
    try:
        while True:
            chunk = await body.read(STREAM_CHUNK_SIZE)
            if not chunk:
                break
            yield chunk
    finally:
        await _release_body(body)


async def _zip_members(
    context: S3Context,
    bucket: str,
    entries: list[_ResolvedZipEntry],
) -> AsyncIterator[tuple[str, datetime, int, Any, AsyncIterator[bytes]]]:
    errors: list[str] = []
    for entry in entries:
        params: dict[str, object] = {"Bucket": bucket, "Key": entry.key}
        if entry.version_id:
            params["VersionId"] = entry.version_id
        try:
            response = await context.client.get_object(**params)
        except Exception as error:  # noqa: BLE001 - best-effort per object
            errors.append(f"{entry.key}: {error}")
            continue
        body = response.get("Body")
        if body is None:
            errors.append(f"{entry.key}: missing response body")
            continue
        last_modified = response.get("LastModified")
        modified_at = last_modified if isinstance(last_modified, datetime) else datetime.now(UTC)
        yield (
            entry.name,
            modified_at,
            S_IFREG | 0o600,
            ZIP_64,
            _member_data(body),
        )

    if errors:
        yield (
            ERROR_MANIFEST_NAME,
            datetime.now(UTC),
            S_IFREG | 0o600,
            ZIP_64,
            _error_manifest(errors),
        )


async def _error_manifest(errors: list[str]) -> AsyncIterator[bytes]:  # noqa: RUF029
    # Async generator (no awaits of its own) so it matches async_stream_zip's
    # requirement that every member's data be an async iterable.
    header = f"{len(errors)} object(s) could not be added to this archive:\n\n"
    yield header.encode("utf-8")
    for line in errors:
        yield f"- {line}\n".encode()


@router.get("/{connection_id}/{bucket}/batch-zip")
async def download_batch_zip(
    request: Request,
    context: S3Context = Depends(get_s3_context),
) -> StreamingResponse:
    bucket = require_bucket(context)
    token = request.query_params.get("ticket")
    if not token:
        raise HTTPException(status_code=400, detail="Missing download ticket")

    now = time.monotonic()
    _prune_expired_tickets(now)
    ticket = _ZIP_TICKETS.pop(token, None)
    if ticket is None or ticket.expires_at <= now:
        raise HTTPException(status_code=404, detail="Download ticket not found or expired")
    if ticket.connection_id != context.connection_id or ticket.bucket != bucket:
        raise HTTPException(status_code=404, detail="Download ticket not found or expired")

    return StreamingResponse(
        async_stream_zip(_zip_members(context, bucket, ticket.entries)),
        media_type="application/zip",
        headers={
            "Content-Disposition": build_content_disposition("attachment", ticket.archive_name),
        },
    )
