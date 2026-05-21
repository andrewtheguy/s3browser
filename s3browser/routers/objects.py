from __future__ import annotations

import os
from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from s3browser.async_s3 import KeyToDelete, MultipartPart, S3Client, S3Error
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
async def list_objects(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    prefix = request.query_params.get("prefix", "")
    continuation_token = request.query_params.get("continuationToken")
    include_versions = request.query_params.get("versions") == "1"
    objects: list[dict[str, object]] = []
    if include_versions:
        markers = decode_version_token(continuation_token)
        try:
            response = await context.client.list_object_versions(
                bucket,
                prefix=prefix,
                delimiter="/",
                max_keys=1000,
                key_marker=markers.get("KeyMarker"),
                version_id_marker=markers.get("VersionIdMarker"),
            )
        except S3Error as error:
            if is_access_denied(error):
                raise HTTPException(status_code=403, detail="Access denied") from error
            if error.code == "NotImplemented":
                raise HTTPException(
                    status_code=501,
                    detail={"error": "Versioning not supported", "code": "NotImplemented"},
                ) from error
            print(f"Failed to list object versions: {error}")
            raise HTTPException(status_code=500, detail="Internal server error") from error
        for common_prefix in response.common_prefixes:
            objects.append(_object_response(common_prefix, is_folder=True))
        for version in response.versions:
            if not version.key or version.key == prefix:
                continue
            if version.is_delete_marker:
                objects.append(
                    _object_response(
                        version.key,
                        last_modified=version.last_modified,
                        is_folder=version.key.endswith("/"),
                        versionId=version.version_id,
                        isLatest=version.is_latest,
                        isDeleteMarker=True,
                    )
                )
            else:
                objects.append(
                    _object_response(
                        version.key,
                        size=version.size,
                        last_modified=version.last_modified,
                        is_folder=False,
                        etag=version.etag,
                        versionId=version.version_id,
                        isLatest=version.is_latest,
                    )
                )
        return {
            "objects": objects,
            "continuationToken": encode_version_token(
                response.next_key_marker, response.next_version_id_marker
            ),
            "isTruncated": response.is_truncated,
        }
    try:
        response = await context.client.list_objects_v2(
            bucket,
            prefix=prefix,
            delimiter="/",
            max_keys=1000,
            continuation_token=continuation_token,
        )
    except S3Error as error:
        if is_access_denied(error):
            raise HTTPException(status_code=403, detail="Access denied") from error
        print(f"Failed to list objects: {error}")
        raise HTTPException(status_code=500, detail="Internal server error") from error
    for common_prefix in response.common_prefixes:
        objects.append(_object_response(common_prefix, is_folder=True))
    for item in response.contents:
        if not item.key or item.key == prefix:
            continue
        objects.append(
            _object_response(
                item.key,
                size=item.size,
                last_modified=item.last_modified,
                is_folder=False,
                etag=item.etag,
            )
        )
    return {
        "objects": objects,
        "continuationToken": response.next_continuation_token,
        "isTruncated": response.is_truncated,
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


async def _seed_test_items(client: S3Client, bucket: str, prefix: str) -> None:
    width = len(str(TEST_SEED_COUNT))
    for index in range(TEST_SEED_COUNT):
        key = f"{prefix}item-{index + 1:0{width}d}.txt"
        await client.put_object(bucket, key, b"", content_type="text/plain")


@router.post("/{connection_id}/{bucket}/seed-test-items")
async def seed_test_items(
    body: SeedTestItemsRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    if os.environ.get("FEATURE_SEED_TEST_ITEMS") not in {"true", "1"}:
        raise HTTPException(status_code=404, detail="Not found")
    if not body.prefix:
        raise HTTPException(status_code=400, detail="Prefix is required")
    prefix = sanitize_folder_path(body.prefix)
    await _seed_test_items(context.client, require_bucket(context), prefix)
    return {"created": TEST_SEED_COUNT, "prefix": prefix}


@router.delete("/{connection_id}/{bucket}")
async def delete_object(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, bool]:
    bucket = require_bucket(context)
    key = validate_object_key(request.query_params.get("key"))
    version_id = sanitize_version_id(request.query_params.get("versionId"))
    await context.client.delete_object(bucket, key, version_id=version_id)
    return {"success": True}


@router.post("/{connection_id}/{bucket}/batch-delete")
async def batch_delete(
    body: BatchDeleteRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    if not body.keys:
        raise HTTPException(status_code=400, detail="Keys must be a non-empty array")
    file_keys: list[KeyToDelete] = []
    for entry in body.keys:
        if not entry.key:
            continue
        key = entry.key.strip()
        if not key:
            continue
        version_id = sanitize_version_id(entry.versionId)
        if key.endswith("/") and not version_id:
            continue
        file_keys.append(KeyToDelete(key=key, version_id=version_id))
    if not file_keys:
        raise HTTPException(status_code=400, detail="No valid file keys provided")
    if len(file_keys) > MAX_BATCH_OPERATIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete more than {MAX_BATCH_OPERATIONS} objects at once",
        )
    result = await context.client.delete_objects(bucket, file_keys, quiet=False)
    deleted: list[dict[str, object]] = []
    for entry in result.deleted:
        if not entry.key:
            continue
        item: dict[str, object] = {"key": entry.key}
        effective_version = entry.version_id or entry.delete_marker_version_id
        if effective_version:
            item["versionId"] = effective_version
        deleted.append(item)
    errors = [
        {"key": err.key, "message": err.message or "Unknown error"}
        for err in result.errors
        if err.key
    ]
    return {"deleted": deleted, "errors": errors}


@router.post("/{connection_id}/{bucket}/folder")
async def create_folder(
    body: FolderRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    folder_path = sanitize_folder_path(body.path)
    await context.client.put_object(
        require_bucket(context),
        folder_path,
        b"",
        content_type="application/x-directory",
    )
    return {"success": True, "key": folder_path}


def _copy_source(bucket: str, key: str, version_id: str | None = None) -> str:
    source = quote(f"{bucket}/{key}", safe="/")
    return f"{source}?versionId={quote(version_id, safe='')}" if version_id else source


async def _copy_object_multipart(
    client: S3Client,
    bucket: str,
    source_key: str,
    destination_key: str,
    size: int,
    version_id: str | None,
) -> None:
    upload_id = await client.create_multipart_upload(bucket, destination_key)
    try:
        parts: list[MultipartPart] = []
        total_parts = (size + COPY_PART_SIZE - 1) // COPY_PART_SIZE
        for part_number in range(1, total_parts + 1):
            start = (part_number - 1) * COPY_PART_SIZE
            end = min(part_number * COPY_PART_SIZE - 1, size - 1)
            copy_result = await client.upload_part_copy(
                bucket,
                destination_key,
                upload_id=upload_id,
                part_number=part_number,
                copy_source=_copy_source(bucket, source_key, version_id),
                copy_source_range=f"bytes={start}-{end}",
            )
            if not copy_result.etag:
                raise RuntimeError(f"Failed to copy part {part_number}")
            parts.append(MultipartPart(part_number=part_number, etag=copy_result.etag))
        await client.complete_multipart_upload(
            bucket, destination_key, upload_id=upload_id, parts=parts
        )
    except Exception:
        try:
            await client.abort_multipart_upload(bucket, destination_key, upload_id=upload_id)
        except Exception as abort_error:
            print(f"Failed to abort multipart copy: {abort_error}")
        raise


async def _copy_object(
    client: S3Client,
    bucket: str,
    source_key: str,
    destination_key: str,
    version_id: str | None = None,
) -> None:
    head = await client.head_object(bucket, source_key, version_id=version_id)
    size = head.content_length or 0
    if size > MULTIPART_COPY_THRESHOLD:
        await _copy_object_multipart(client, bucket, source_key, destination_key, size, version_id)
    else:
        await client.copy_object(
            bucket,
            destination_key,
            copy_source=_copy_source(bucket, source_key, version_id),
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
async def copy_object(
    body: CopyRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, bool]:
    source_key, destination_key = _validate_copy_request(body.sourceKey, body.destinationKey)
    await _copy_object(
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
async def batch_copy(
    body: BatchCopyRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    operations = _validate_batch_operations(body.operations, "copy")
    bucket = require_bucket(context)
    successful: list[str] = []
    errors: list[dict[str, str]] = []
    for operation in operations:
        try:
            await _copy_object(
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
async def move_object(
    body: CopyRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    source_key, destination_key = _validate_copy_request(body.sourceKey, body.destinationKey)
    bucket = require_bucket(context)
    version_id = sanitize_version_id(body.versionId)
    await _copy_object(context.client, bucket, source_key, destination_key, version_id)
    try:
        await context.client.delete_object(bucket, source_key, version_id=version_id)
    except Exception as delete_error:
        try:
            await context.client.delete_object(bucket, destination_key)
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
async def batch_move(
    body: BatchCopyRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    operations = _validate_batch_operations(body.operations, "move")
    bucket = require_bucket(context)
    successful: list[str] = []
    errors: list[dict[str, str]] = []
    for operation in operations:
        version_id = sanitize_version_id(operation.versionId)
        try:
            await _copy_object(
                context.client, bucket, operation.sourceKey, operation.destinationKey, version_id
            )
            try:
                await context.client.delete_object(
                    bucket, operation.sourceKey, version_id=version_id
                )
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
async def object_metadata(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    bucket = require_bucket(context)
    key = validate_object_key(request.query_params.get("key"))
    version_id = sanitize_version_id(request.query_params.get("versionId"))
    try:
        result = await context.client.head_object(
            bucket, key, version_id=version_id, checksum_mode=True
        )
    except S3Error as error:
        if error.code in {"NotFound", "NoSuchKey"} or error.status == 404:
            raise HTTPException(status_code=404, detail="Object not found") from error
        raise
    return {
        "key": key,
        "size": result.content_length,
        "lastModified": result.last_modified,
        "contentType": result.content_type,
        "etag": result.etag,
        "versionId": result.version_id,
        "serverSideEncryption": result.server_side_encryption,
        "sseKmsKeyId": result.sse_kms_key_id,
        "sseCustomerAlgorithm": result.sse_customer_algorithm,
        "storageClass": result.storage_class,
        "vendor": detect_s3_vendor(context.credentials.endpoint),
        "cacheControl": result.cache_control,
        "contentDisposition": result.content_disposition,
        "contentEncoding": result.content_encoding,
        "checksumSHA256": result.checksum_sha256,
        "checksumSHA1": result.checksum_sha1,
        "checksumCRC32": result.checksum_crc32,
        "checksumCRC32C": result.checksum_crc32c,
        "checksumCRC64NVME": result.checksum_crc64nvme,
        "checksumType": result.checksum_type,
        "userMetadata": result.metadata,
    }
