from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from s3browser.config import SEARCH_WHITELIST_ENV_VAR, get_search_whitelist_hosts
from s3browser.db import get_index_status, search_object_index
from s3browser.dependencies import get_s3_context
from s3browser.s3 import (
    S3Context,
    detect_s3_vendor,
    get_effective_endpoint_host,
    is_access_denied,
    require_bucket,
)
from s3browser.utils import (
    decode_version_token,
    encode_version_token,
    extract_file_name,
    isoformat_z,
    sanitize_folder_path,
    sanitize_version_id,
    validate_copy_key,
    validate_object_key,
)

router = APIRouter(prefix="/api/objects", tags=["objects"])

MAX_BATCH_OPERATIONS = 1000
TEST_SEED_COUNT = 10005
TEST_SEED_CONCURRENCY = 25
MULTIPART_COPY_THRESHOLD = 5 * 1024 * 1024 * 1024
COPY_PART_SIZE = 100 * 1024 * 1024


class FolderRequest(BaseModel):
    path: str | None = None


class DeleteEntry(BaseModel):
    key: str | None = None
    versionId: str | None = None


class BatchDeleteRequest(BaseModel):
    keys: list[DeleteEntry] | None = None


class CopyRequest(BaseModel):
    sourceKey: str | None = None
    destinationKey: str | None = None
    versionId: str | None = None


class CopyOperation(BaseModel):
    sourceKey: str
    destinationKey: str
    versionId: str | None = None


class BatchCopyRequest(BaseModel):
    operations: list[CopyOperation] | None = None


class SeedTestItemsRequest(BaseModel):
    prefix: str | None = None


def _endpoint_whitelisted(endpoint: str | None) -> tuple[bool, str | None]:
    host = get_effective_endpoint_host(endpoint)
    return host is not None and host in get_search_whitelist_hosts(), host


def _search_disabled() -> dict[str, str]:
    return {
        "error": "Search disabled: this connection's endpoint host is not in "
        f"{SEARCH_WHITELIST_ENV_VAR}.",
        "code": "EndpointNotWhitelisted",
    }


def _epoch_iso(value: int) -> str | None:
    return isoformat_z(datetime.fromtimestamp(value, UTC))


def _parse_limit_offset(request: Request) -> tuple[int, int]:
    try:
        raw_limit = int(request.query_params.get("limit", "100"))
    except ValueError:
        raw_limit = 100
    try:
        raw_offset = int(request.query_params.get("offset", "0"))
    except ValueError:
        raw_offset = 0
    limit = min(raw_limit, 500) if raw_limit > 0 else 100
    offset = raw_offset if raw_offset >= 0 else 0
    return limit, offset


def _object_response(
    key: str,
    *,
    size: int | None = None,
    last_modified: object = None,
    is_folder: bool = False,
    **extra: object,
) -> dict[str, object]:
    item: dict[str, object] = {"key": key, "name": extract_file_name(key), "isFolder": is_folder}
    if size is not None:
        item["size"] = size
    last_modified_iso = isoformat_z(last_modified)
    if last_modified_iso:
        item["lastModified"] = last_modified_iso
    for key_name, value in extra.items():
        if value is not None:
            item[key_name] = value
    return item


@router.get("/{connection_id}/{bucket}")
def list_objects(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    prefix = request.query_params.get("prefix", "")
    continuation_token = request.query_params.get("continuationToken")
    include_versions = request.query_params.get("versions") == "1"
    objects: list[dict[str, object]] = []
    if include_versions:
        markers = decode_version_token(continuation_token)
        params: dict[str, object] = {
            "Bucket": bucket,
            "Prefix": prefix,
            "Delimiter": "/",
            "MaxKeys": 1000,
        }
        if markers.get("KeyMarker"):
            params["KeyMarker"] = markers["KeyMarker"]
        if markers.get("VersionIdMarker"):
            params["VersionIdMarker"] = markers["VersionIdMarker"]
        try:
            response = context.client.list_object_versions(**params)
        except Exception as error:
            if is_access_denied(error):
                raise HTTPException(status_code=403, detail="Access denied") from error
            if "NotImplemented" in str(error):
                raise HTTPException(
                    status_code=501,
                    detail={"error": "Versioning not supported", "code": "NotImplemented"},
                ) from error
            print(f"Failed to list object versions: {error}")
            raise HTTPException(status_code=500, detail="Internal server error") from error
        for item in response.get("CommonPrefixes", []):
            key = item.get("Prefix")
            if key:
                objects.append(_object_response(str(key), is_folder=True))
        for item in response.get("Versions", []):
            key = item.get("Key")
            if key and key != prefix:
                objects.append(
                    _object_response(
                        str(key),
                        size=item.get("Size"),
                        last_modified=item.get("LastModified"),
                        is_folder=False,
                        etag=item.get("ETag"),
                        versionId=item.get("VersionId"),
                        isLatest=item.get("IsLatest"),
                    )
                )
        for item in response.get("DeleteMarkers", []):
            key = item.get("Key")
            if key and key != prefix:
                key_str = str(key)
                objects.append(
                    _object_response(
                        key_str,
                        last_modified=item.get("LastModified"),
                        is_folder=key_str.endswith("/"),
                        versionId=item.get("VersionId"),
                        isLatest=item.get("IsLatest"),
                        isDeleteMarker=True,
                    )
                )
        return {
            "objects": objects,
            "continuationToken": encode_version_token(
                response.get("NextKeyMarker"), response.get("NextVersionIdMarker")
            ),
            "isTruncated": bool(response.get("IsTruncated")),
        }
    params = {"Bucket": bucket, "Prefix": prefix, "Delimiter": "/", "MaxKeys": 1000}
    if continuation_token:
        params["ContinuationToken"] = continuation_token
    try:
        response = context.client.list_objects_v2(**params)
    except Exception as error:
        if is_access_denied(error):
            raise HTTPException(status_code=403, detail="Access denied") from error
        print(f"Failed to list objects: {error}")
        raise HTTPException(status_code=500, detail="Internal server error") from error
    for item in response.get("CommonPrefixes", []):
        key = item.get("Prefix")
        if key:
            objects.append(_object_response(str(key), is_folder=True))
    for item in response.get("Contents", []):
        key = item.get("Key")
        if key and key != prefix:
            objects.append(
                _object_response(
                    str(key),
                    size=item.get("Size"),
                    last_modified=item.get("LastModified"),
                    is_folder=False,
                    etag=item.get("ETag"),
                )
            )
    return {
        "objects": objects,
        "continuationToken": response.get("NextContinuationToken"),
        "isTruncated": bool(response.get("IsTruncated")),
    }


@router.get("/{connection_id}/{bucket}/index-status")
def index_status(context: S3Context = Depends(get_s3_context)) -> dict[str, object]:
    bucket = require_bucket(context)
    whitelisted, endpoint_host = _endpoint_whitelisted(context.connection.endpoint)
    if not whitelisted or endpoint_host is None:
        raise HTTPException(status_code=403, detail=_search_disabled())
    status = get_index_status(endpoint_host, bucket)
    if status is None or status.last_completed_at is None:
        return {"lastIndexedAt": None, "objectCount": None}
    return {
        "lastIndexedAt": _epoch_iso(status.last_completed_at),
        "objectCount": status.object_count,
    }


@router.get("/{connection_id}/{bucket}/search")
def search_objects(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    query = request.query_params.get("q", "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="Search query is required")
    whitelisted, endpoint_host = _endpoint_whitelisted(context.connection.endpoint)
    if not whitelisted or endpoint_host is None:
        raise HTTPException(status_code=403, detail=_search_disabled())
    status = get_index_status(endpoint_host, bucket)
    if status is None or status.last_completed_at is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "Index not built. Run: "
                f"s3browser index --connection {context.connection_id} --bucket {bucket}",
                "code": "IndexNotBuilt",
            },
        )
    limit, offset = _parse_limit_offset(request)
    sort = "last_modified" if request.query_params.get("sort") == "last_modified" else "key"
    direction = "desc" if request.query_params.get("dir") == "desc" else "asc"
    result = search_object_index(
        status.id,
        query,
        limit=limit,
        offset=offset,
        sort=sort,
        direction=direction,
        prefix=request.query_params.get("prefix", ""),
    )
    objects = [
        {
            "key": hit["key"],
            "name": extract_file_name(hit["key"]),
            "size": hit["size"],
            "lastModified": _epoch_iso(hit["last_modified"]),
            "isFolder": str(hit["key"]).endswith("/"),
            "contentSnippet": hit.get("contentSnippet"),
            "contentMatchCount": hit.get("contentMatchCount"),
        }
        for hit in result["hits"]
    ]
    return {
        "objects": objects,
        "total": result["total"],
        "lastIndexedAt": _epoch_iso(status.last_completed_at),
        "objectCount": status.object_count,
    }


def _seed_test_items(client: Any, bucket: str, prefix: str) -> None:
    width = len(str(TEST_SEED_COUNT))
    for index in range(TEST_SEED_COUNT):
        key = f"{prefix}item-{index + 1:0{width}d}.txt"
        client.put_object(Bucket=bucket, Key=key, Body=b"", ContentType="text/plain")


@router.post("/{connection_id}/{bucket}/seed-test-items")
def seed_test_items(
    body: SeedTestItemsRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    if os.environ.get("FEATURE_SEED_TEST_ITEMS") not in {"true", "1"}:
        raise HTTPException(status_code=404, detail="Not found")
    if not body.prefix:
        raise HTTPException(status_code=400, detail="Prefix is required")
    prefix = sanitize_folder_path(body.prefix)
    _seed_test_items(context.client, require_bucket(context), prefix)
    return {"created": TEST_SEED_COUNT, "prefix": prefix}


@router.delete("/{connection_id}/{bucket}")
def delete_object(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, bool]:
    bucket = require_bucket(context)
    key = validate_object_key(request.query_params.get("key"))
    params: dict[str, object] = {"Bucket": bucket, "Key": key}
    version_id = sanitize_version_id(request.query_params.get("versionId"))
    if version_id:
        params["VersionId"] = version_id
    context.client.delete_object(**params)
    return {"success": True}


@router.post("/{connection_id}/{bucket}/batch-delete")
def batch_delete(
    body: BatchDeleteRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    if not body.keys:
        raise HTTPException(status_code=400, detail="Keys must be a non-empty array")
    file_keys = [
        {
            "Key": entry.key.strip(),
            **(
                {"VersionId": version_id}
                if (version_id := sanitize_version_id(entry.versionId))
                else {}
            ),
        }
        for entry in body.keys
        if entry.key
        and entry.key.strip()
        and (not entry.key.strip().endswith("/") or sanitize_version_id(entry.versionId))
    ]
    if not file_keys:
        raise HTTPException(status_code=400, detail="No valid file keys provided")
    if len(file_keys) > MAX_BATCH_OPERATIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete more than {MAX_BATCH_OPERATIONS} objects at once",
        )
    response = context.client.delete_objects(
        Bucket=bucket, Delete={"Objects": file_keys, "Quiet": False}
    )
    return {
        "deleted": [
            {
                "key": item.get("Key"),
                **(
                    {"versionId": item.get("VersionId") or item.get("DeleteMarkerVersionId")}
                    if item.get("VersionId") or item.get("DeleteMarkerVersionId")
                    else {}
                ),
            }
            for item in response.get("Deleted", [])
            if item.get("Key")
        ],
        "errors": [
            {"key": item.get("Key"), "message": item.get("Message") or "Unknown error"}
            for item in response.get("Errors", [])
            if item.get("Key")
        ],
    }


@router.post("/{connection_id}/{bucket}/folder")
def create_folder(
    body: FolderRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    folder_path = sanitize_folder_path(body.path)
    context.client.put_object(
        Bucket=require_bucket(context),
        Key=folder_path,
        Body=b"",
        ContentType="application/x-directory",
    )
    return {"success": True, "key": folder_path}


def _copy_source(bucket: str, key: str, version_id: str | None = None) -> str:
    source = quote(f"{bucket}/{key}", safe="/")
    return f"{source}?versionId={quote(version_id, safe='')}" if version_id else source


def _copy_object_multipart(
    client: Any,
    bucket: str,
    source_key: str,
    destination_key: str,
    size: int,
    version_id: str | None,
) -> None:
    create_response = client.create_multipart_upload(Bucket=bucket, Key=destination_key)
    upload_id = create_response.get("UploadId")
    if not upload_id:
        raise RuntimeError("Failed to initiate multipart upload")
    try:
        parts: list[dict[str, object]] = []
        total_parts = (size + COPY_PART_SIZE - 1) // COPY_PART_SIZE
        for part_number in range(1, total_parts + 1):
            start = (part_number - 1) * COPY_PART_SIZE
            end = min(part_number * COPY_PART_SIZE - 1, size - 1)
            response = client.upload_part_copy(
                Bucket=bucket,
                Key=destination_key,
                CopySource=_copy_source(bucket, source_key, version_id),
                UploadId=upload_id,
                PartNumber=part_number,
                CopySourceRange=f"bytes={start}-{end}",
            )
            etag = response.get("CopyPartResult", {}).get("ETag")
            if not etag:
                raise RuntimeError(f"Failed to copy part {part_number}")
            parts.append({"ETag": etag, "PartNumber": part_number})
        client.complete_multipart_upload(
            Bucket=bucket, Key=destination_key, UploadId=upload_id, MultipartUpload={"Parts": parts}
        )
    except Exception:
        client.abort_multipart_upload(Bucket=bucket, Key=destination_key, UploadId=upload_id)
        raise


def _copy_object(
    client: Any,
    bucket: str,
    source_key: str,
    destination_key: str,
    version_id: str | None = None,
) -> None:
    head_params: dict[str, object] = {"Bucket": bucket, "Key": source_key}
    if version_id:
        head_params["VersionId"] = version_id
    head = client.head_object(**head_params)
    size = int(head.get("ContentLength") or 0)
    if size > MULTIPART_COPY_THRESHOLD:
        _copy_object_multipart(client, bucket, source_key, destination_key, size, version_id)
    else:
        client.copy_object(
            Bucket=bucket,
            Key=destination_key,
            CopySource=_copy_source(bucket, source_key, version_id),
        )


def _validate_copy_request(source_key: str | None, destination_key: str | None) -> tuple[str, str]:
    if not source_key or not destination_key:
        raise HTTPException(status_code=400, detail="sourceKey and destinationKey are required")
    validate_copy_key(source_key, "sourceKey")
    validate_copy_key(destination_key, "destinationKey")
    if source_key == destination_key:
        raise HTTPException(
            status_code=400, detail="Source and destination keys cannot be the same"
        )
    return source_key, destination_key


@router.post("/{connection_id}/{bucket}/copy")
def copy_object(body: CopyRequest, context: S3Context = Depends(get_s3_context)) -> dict[str, bool]:
    source_key, destination_key = _validate_copy_request(body.sourceKey, body.destinationKey)
    _copy_object(
        context.client,
        require_bucket(context),
        source_key,
        destination_key,
        sanitize_version_id(body.versionId),
    )
    return {"success": True}


def _validate_batch_operations(
    operations: list[CopyOperation] | None, verb: str
) -> list[CopyOperation]:
    if not operations:
        raise HTTPException(status_code=400, detail="Operations must be a non-empty array")
    if len(operations) > MAX_BATCH_OPERATIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot {verb} more than {MAX_BATCH_OPERATIONS} objects at once",
        )
    for operation in operations:
        if not operation.sourceKey or not operation.destinationKey:
            raise HTTPException(
                status_code=400, detail="Each operation must have sourceKey and destinationKey"
            )
        if operation.sourceKey == operation.destinationKey:
            raise HTTPException(
                status_code=400,
                detail="sourceKey and destinationKey must differ for operation with key "
                f'"{operation.sourceKey}"',
            )
        validate_copy_key(operation.sourceKey, f'sourceKey "{operation.sourceKey}"')
        validate_copy_key(
            operation.destinationKey,
            f'destinationKey "{operation.destinationKey}"',
        )
    return operations


@router.post("/{connection_id}/{bucket}/batch-copy")
def batch_copy(
    body: BatchCopyRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    operations = _validate_batch_operations(body.operations, "copy")
    bucket = require_bucket(context)
    successful: list[str] = []
    errors: list[dict[str, str]] = []
    for operation in operations:
        try:
            _copy_object(
                context.client,
                bucket,
                operation.sourceKey,
                operation.destinationKey,
                sanitize_version_id(operation.versionId),
            )
            successful.append(operation.sourceKey)
        except Exception as error:
            errors.append(
                {"sourceKey": operation.sourceKey, "message": str(error) or "Copy failed"}
            )
    return {"successful": successful, "errors": errors}


@router.post("/{connection_id}/{bucket}/move")
def move_object(
    body: CopyRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    source_key, destination_key = _validate_copy_request(body.sourceKey, body.destinationKey)
    bucket = require_bucket(context)
    version_id = sanitize_version_id(body.versionId)
    _copy_object(context.client, bucket, source_key, destination_key, version_id)
    try:
        params: dict[str, object] = {"Bucket": bucket, "Key": source_key}
        if version_id:
            params["VersionId"] = version_id
        context.client.delete_object(**params)
    except Exception as delete_error:
        try:
            context.client.delete_object(Bucket=bucket, Key=destination_key)
        except Exception as rollback_error:
            print(f"Move rollback failed: {rollback_error}")
            raise HTTPException(
                status_code=500,
                detail={
                    "success": False,
                    "partial": True,
                    "message": "Move failed: copy succeeded but source delete failed, "
                    "and rollback failed",
                    "destinationKey": destination_key,
                    "error": str(delete_error) or "Delete failed",
                },
            ) from delete_error
        raise HTTPException(
            status_code=500,
            detail={
                "success": False,
                "message": "Move failed: copy succeeded but source delete failed "
                "(copy was rolled back)",
                "error": str(delete_error) or "Delete failed",
            },
        ) from delete_error
    return {"success": True}


@router.post("/{connection_id}/{bucket}/batch-move")
def batch_move(
    body: BatchCopyRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    operations = _validate_batch_operations(body.operations, "move")
    bucket = require_bucket(context)
    successful: list[str] = []
    errors: list[dict[str, str]] = []
    for operation in operations:
        version_id = sanitize_version_id(operation.versionId)
        try:
            _copy_object(
                context.client, bucket, operation.sourceKey, operation.destinationKey, version_id
            )
            try:
                params: dict[str, object] = {"Bucket": bucket, "Key": operation.sourceKey}
                if version_id:
                    params["VersionId"] = version_id
                context.client.delete_object(**params)
                successful.append(operation.sourceKey)
            except Exception as delete_error:
                errors.append(
                    {
                        "sourceKey": operation.sourceKey,
                        "destinationKey": operation.destinationKey,
                        "message": "Delete failed after successful copy; "
                        f"destination created: {delete_error}",
                    }
                )
        except Exception as error:
            errors.append(
                {
                    "sourceKey": operation.sourceKey,
                    "message": str(error) or "Copy failed",
                }
            )
    return {"successful": successful, "errors": errors}


@router.get("/{connection_id}/{bucket}/metadata")
def object_metadata(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    key = validate_object_key(request.query_params.get("key"))
    params: dict[str, object] = {"Bucket": bucket, "Key": key, "ChecksumMode": "ENABLED"}
    version_id = sanitize_version_id(request.query_params.get("versionId"))
    if version_id:
        params["VersionId"] = version_id
    try:
        response = context.client.head_object(**params)
    except Exception as error:
        if "NotFound" in str(error) or "NoSuchKey" in str(error):
            raise HTTPException(status_code=404, detail="Object not found") from error
        raise
    return {
        "key": key,
        "size": response.get("ContentLength"),
        "lastModified": isoformat_z(response.get("LastModified")),
        "contentType": response.get("ContentType"),
        "etag": response.get("ETag"),
        "versionId": response.get("VersionId"),
        "serverSideEncryption": response.get("ServerSideEncryption"),
        "sseKmsKeyId": response.get("SSEKMSKeyId"),
        "sseCustomerAlgorithm": response.get("SSECustomerAlgorithm"),
        "storageClass": response.get("StorageClass"),
        "vendor": detect_s3_vendor(context.credentials.endpoint),
        "cacheControl": response.get("CacheControl"),
        "contentDisposition": response.get("ContentDisposition"),
        "contentEncoding": response.get("ContentEncoding"),
        "checksumSHA256": response.get("ChecksumSHA256"),
        "checksumSHA1": response.get("ChecksumSHA1"),
        "checksumCRC32": response.get("ChecksumCRC32"),
        "checksumCRC32C": response.get("ChecksumCRC32C"),
        "checksumCRC64NVME": response.get("ChecksumCRC64NVME"),
        "checksumType": response.get("ChecksumType"),
        "userMetadata": response.get("Metadata"),
    }
