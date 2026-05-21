from __future__ import annotations

import math
import time
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from s3browser.dependencies import get_s3_context
from s3browser.s3 import S3Context, require_bucket
from s3browser.utils import validate_object_key

router = APIRouter(prefix="/api/upload", tags=["upload"])

PART_SIZE = 10 * 1024 * 1024
MULTIPART_THRESHOLD = 10 * 1024 * 1024
MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024
RAW_SINGLE_LIMIT = max(MULTIPART_THRESHOLD, PART_SIZE)
RAW_PART_LIMIT = max(PART_SIZE, MULTIPART_THRESHOLD)


@dataclass
class UploadTrackingData:
    key: str
    sanitized_key: str
    total_parts: int
    content_type: str
    created_at: float
    file_size: int


class InitiateUploadBody(BaseModel):
    key: str | None = None
    contentType: str | None = None
    fileSize: int | None = None


class CompletePart(BaseModel):
    partNumber: int
    etag: str


class CompleteUploadBody(BaseModel):
    uploadId: str | None = None
    key: str | None = None
    parts: list[CompletePart] | None = None


class AbortUploadBody(BaseModel):
    uploadId: str | None = None
    key: str | None = None


_upload_tracker: dict[str, UploadTrackingData] = {}


def _tracking_key(connection_id: int, bucket: str, upload_id: str) -> str:
    return f"{connection_id}:{bucket}:{upload_id}"


def _cleanup_upload_tracker() -> None:
    now = time.time()
    for key, data in list(_upload_tracker.items()):
        if now - data.created_at > 24 * 60 * 60:
            del _upload_tracker[key]


@router.post("/{connection_id}/{bucket}/single")
async def upload_single(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    key = validate_object_key(
        request.query_params.get("key"), message="Key query parameter is required"
    )
    body = await request.body()
    if len(body) > RAW_SINGLE_LIMIT:
        raise HTTPException(status_code=413, detail="Request body too large")
    content_type = request.headers.get("content-type") or "application/octet-stream"
    try:
        await context.client.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)
    except Exception as error:
        print(f"Single file upload failed: {error}")
        raise HTTPException(status_code=500, detail="Single file upload failed") from error
    return {"success": True, "key": key}


@router.post("/{connection_id}/{bucket}/initiate")
async def initiate_upload(
    body: InitiateUploadBody, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    if not body.key:
        raise HTTPException(status_code=400, detail="Key is required")
    if body.fileSize is None or body.fileSize <= 0:
        raise HTTPException(status_code=400, detail="Valid fileSize is required")
    if body.fileSize > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400, detail=f"File size exceeds maximum of {MAX_FILE_SIZE} bytes"
        )
    key = validate_object_key(body.key, message="Key is required")
    try:
        response = await context.client.create_multipart_upload(
            Bucket=bucket,
            Key=key,
            ContentType=body.contentType or "application/octet-stream",
        )
    except Exception as error:
        print(f"Failed to initiate multipart upload: {error}")
        raise HTTPException(
            status_code=500, detail="Failed to initiate multipart upload"
        ) from error
    upload_id = response.get("UploadId")
    if not upload_id:
        raise HTTPException(status_code=500, detail="Failed to initiate multipart upload")
    total_parts = math.ceil(body.fileSize / PART_SIZE)
    _cleanup_upload_tracker()
    _upload_tracker[_tracking_key(context.connection_id, bucket, upload_id)] = UploadTrackingData(
        key=body.key,
        sanitized_key=key,
        total_parts=total_parts,
        content_type=body.contentType or "application/octet-stream",
        created_at=time.time(),
        file_size=body.fileSize,
    )
    return {"uploadId": upload_id, "key": key, "totalParts": total_parts, "partSize": PART_SIZE}


@router.post("/{connection_id}/{bucket}/part")
async def upload_part(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    upload_id = request.query_params.get("uploadId")
    key = request.query_params.get("key")
    raw_part_number = request.query_params.get("partNumber")
    if not upload_id:
        raise HTTPException(status_code=400, detail="uploadId query parameter is required")
    if not raw_part_number or not raw_part_number.isdigit() or int(raw_part_number) < 1:
        raise HTTPException(
            status_code=400, detail="Valid partNumber query parameter (>= 1) is required"
        )
    if not key:
        raise HTTPException(status_code=400, detail="key query parameter is required")
    part_number = int(raw_part_number)
    tracked = _upload_tracker.get(_tracking_key(context.connection_id, bucket, upload_id))
    if tracked is None:
        raise HTTPException(status_code=404, detail="Upload not found or expired")
    if key != tracked.sanitized_key:
        raise HTTPException(status_code=403, detail="Key does not match the upload")
    if part_number > tracked.total_parts:
        raise HTTPException(
            status_code=400,
            detail=f"Part number {part_number} exceeds total parts {tracked.total_parts}",
        )
    body = await request.body()
    if len(body) > RAW_PART_LIMIT:
        raise HTTPException(status_code=413, detail="Request body too large")
    try:
        response = await context.client.upload_part(
            Bucket=bucket,
            Key=tracked.sanitized_key,
            UploadId=upload_id,
            PartNumber=part_number,
            Body=body,
        )
    except Exception as error:
        print(f"Upload part failed: {error}")
        raise HTTPException(status_code=500, detail="Upload part failed") from error
    return {"etag": response.get("ETag")}


@router.post("/{connection_id}/{bucket}/complete")
async def complete_upload(
    body: CompleteUploadBody, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    if not body.uploadId:
        raise HTTPException(status_code=400, detail="uploadId is required")
    if not body.key:
        raise HTTPException(status_code=400, detail="Key is required")
    if not body.parts:
        raise HTTPException(status_code=400, detail="Parts array is required")
    tracking_key = _tracking_key(context.connection_id, bucket, body.uploadId)
    tracked = _upload_tracker.get(tracking_key)
    if tracked is None:
        raise HTTPException(status_code=404, detail="Upload not found or expired")
    if body.key != tracked.sanitized_key:
        raise HTTPException(status_code=403, detail="Key does not match the upload")
    parts = sorted(body.parts, key=lambda part: part.partNumber)
    try:
        await context.client.complete_multipart_upload(
            Bucket=bucket,
            Key=tracked.sanitized_key,
            UploadId=body.uploadId,
            MultipartUpload={
                "Parts": [{"PartNumber": part.partNumber, "ETag": part.etag} for part in parts]
            },
        )
    except Exception as error:
        try:
            await context.client.abort_multipart_upload(
                Bucket=bucket, Key=tracked.sanitized_key, UploadId=body.uploadId
            )
        except Exception as abort_error:
            print(f"Failed to abort multipart upload after completion failure: {abort_error}")
        _upload_tracker.pop(tracking_key, None)
        print(f"Failed to complete multipart upload: {error}")
        raise HTTPException(
            status_code=500, detail="Failed to complete multipart upload"
        ) from error
    _upload_tracker.pop(tracking_key, None)
    return {"success": True, "key": tracked.sanitized_key}


@router.post("/{connection_id}/{bucket}/abort")
async def abort_upload(
    body: AbortUploadBody, context: S3Context = Depends(get_s3_context)
) -> dict[str, bool]:
    bucket = require_bucket(context)
    if not body.uploadId:
        raise HTTPException(status_code=400, detail="uploadId is required")
    if not body.key:
        raise HTTPException(status_code=400, detail="Key is required")
    tracking_key = _tracking_key(context.connection_id, bucket, body.uploadId)
    tracked = _upload_tracker.get(tracking_key)
    key = validate_object_key(body.key, message="Key is required")
    if tracked is not None:
        if key != tracked.sanitized_key:
            raise HTTPException(status_code=400, detail="Key does not match the upload")
        key = tracked.sanitized_key
    try:
        await context.client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=body.uploadId)
    except Exception as error:
        print(f"Failed to abort multipart upload: {error}")
        raise HTTPException(status_code=500, detail="Failed to abort multipart upload") from error
    finally:
        _upload_tracker.pop(tracking_key, None)
    return {"success": True}
