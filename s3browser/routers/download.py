from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from s3browser.async_s3.client import GetObjectResponse
from s3browser.dependencies import get_s3_context
from s3browser.s3 import S3Context, is_access_denied, is_not_found, require_bucket
from s3browser.utils import (
    build_content_disposition,
    extract_file_name,
    sanitize_version_id,
    validate_content_type,
    validate_object_key,
)

router = APIRouter(prefix="/api/download", tags=["download"])


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
    response_disposition: str | None = None
    if disposition == "inline":
        response_disposition = "inline"
    elif disposition == "attachment":
        response_disposition = build_content_disposition("attachment", filename)
    try:
        url = context.client.generate_presigned_url(
            bucket,
            key,
            expires_in=ttl,
            version_id=version_id,
            response_content_disposition=response_disposition,
            response_content_type=content_type,
        )
    except Exception as error:
        print(f"Failed to generate presigned URL: {error}")
        raise HTTPException(status_code=500, detail="Failed to generate presigned URL") from error
    return {"url": url}


def _iter_body(response: GetObjectResponse) -> AsyncIterator[bytes]:
    return response.aiter_bytes()


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
    try:
        response = await context.client.get_object(
            bucket,
            key,
            version_id=version_id,
            range_header=range_header,
        )
    except Exception as error:
        if is_access_denied(error):
            raise HTTPException(status_code=403, detail="Access denied") from error
        if is_not_found(error):
            raise HTTPException(status_code=404, detail="Object not found") from error
        print(f"Failed to stream object: {error}")
        raise HTTPException(status_code=500, detail="Failed to stream object") from error
    filename = extract_file_name(key) or "download"
    content_type = content_type_override or response.content_type or "application/octet-stream"
    headers: dict[str, str] = {
        "Content-Disposition": "inline"
        if disposition == "inline"
        else build_content_disposition("attachment", filename),
        "Content-Type": content_type,
        "Accept-Ranges": response.accept_ranges or "bytes",
    }
    if response.content_length is not None:
        headers["Content-Length"] = str(response.content_length)
    if response.content_range:
        headers["Content-Range"] = response.content_range
    return StreamingResponse(
        _iter_body(response),
        status_code=206 if response.content_range else 200,
        headers=headers,
        media_type=headers["Content-Type"],
        background=BackgroundTask(response.aclose),
    )
