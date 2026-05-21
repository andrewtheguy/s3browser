from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC
from urllib.parse import urlparse

from fastapi import HTTPException

from s3browser.async_s3 import S3Client, S3Error
from s3browser.db import S3Connection, decrypt_connection_secret_key, update_connection_last_used
from s3browser.utils import isoformat_z

S3Vendor = str

_bucket_region_cache: dict[str, str] = {}


@dataclass(frozen=True)
class S3Credentials:
    access_key_id: str
    secret_access_key: str
    region: str
    bucket: str | None = None
    endpoint: str | None = None


@dataclass
class S3Context:
    connection_id: int
    connection: S3Connection
    client: S3Client
    credentials: S3Credentials

    async def aclose(self) -> None:
        await self.client.aclose()


def clear_bucket_region_cache() -> None:
    _bucket_region_cache.clear()
    print("[s3browser] Bucket region cache cleared")


def detect_s3_vendor(endpoint: str | None = None) -> S3Vendor:
    if not endpoint:
        return "aws"
    normalized = endpoint.lower()
    if "amazonaws.com" in normalized:
        return "aws"
    if "backblazeb2.com" in normalized:
        return "b2"
    return "other"


def normalize_endpoint(endpoint: str | None) -> str | None:
    if not endpoint:
        return None
    if endpoint.startswith(("http://", "https://")):
        return endpoint
    return f"https://{endpoint}"


def get_effective_endpoint_host(endpoint: str | None) -> str | None:
    normalized = normalize_endpoint(endpoint.strip()) if endpoint else None
    if not normalized:
        return None
    parsed = urlparse(normalized)
    return parsed.hostname.lower() if parsed.hostname else None


def is_access_denied(error: object) -> bool:
    if isinstance(error, S3Error):
        return error.code in {"AccessDenied", "Forbidden"} or error.status == 403
    return False


def is_not_found(error: object) -> bool:
    if isinstance(error, S3Error):
        return error.code in {"NoSuchKey", "NoSuchBucket", "NotFound"} or error.status == 404
    return False


def error_code(error: object) -> str:
    if isinstance(error, S3Error):
        return error.code
    return getattr(error, "name", "") or error.__class__.__name__


def format_error_with_code(error: object) -> str:
    if isinstance(error, S3Error):
        return f"{error.code}: {error.message}"
    return str(error) or "Unknown error"


def create_s3_client(credentials: S3Credentials) -> S3Client:
    endpoint = normalize_endpoint(credentials.endpoint)
    return S3Client(
        access_key_id=credentials.access_key_id,
        secret_access_key=credentials.secret_access_key,
        region=credentials.region,
        endpoint_url=endpoint,
    )


async def get_bucket_region(
    access_key_id: str, secret_access_key: str, bucket: str, endpoint: str | None = None
) -> str:
    if endpoint:
        return "us-east-1"
    async with S3Client(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        region="us-east-1",
    ) as client:
        try:
            head = await client.head_bucket(bucket)
            if head.region:
                return head.region
        except S3Error as error:
            region = error.headers.get("x-amz-bucket-region")
            if region:
                return region
            if error.code not in {"AccessDenied", "Forbidden"}:
                print(f"Failed to head bucket: {error}")
        try:
            location = await client.get_bucket_location(bucket)
        except S3Error as error:
            print(f"Failed to get bucket location: {error}")
            raise RuntimeError(
                "Failed to detect bucket region. Please specify the region manually."
            ) from error
        if not location:
            return "us-east-1"
        if location == "EU":
            return "eu-west-1"
        return location


async def create_s3_context_from_connection(
    connection: S3Connection, bucket: str | None = None
) -> S3Context:
    secret = decrypt_connection_secret_key(connection)
    endpoint = normalize_endpoint(connection.endpoint)
    effective_bucket = bucket or connection.bucket
    region = connection.region or "us-east-1"
    if connection.auto_detect_region and effective_bucket and not endpoint:
        cache_key = f"{connection.id}:{effective_bucket}"
        if cache_key in _bucket_region_cache:
            region = _bucket_region_cache[cache_key]
        else:
            try:
                region = await get_bucket_region(
                    connection.access_key_id, secret, effective_bucket, endpoint
                )
                _bucket_region_cache[cache_key] = region
            except RuntimeError as error:
                print(f"Failed to auto-detect bucket region, using connection region: {error}")
    credentials = S3Credentials(
        access_key_id=connection.access_key_id,
        secret_access_key=secret,
        region=region,
        bucket=effective_bucket,
        endpoint=endpoint,
    )
    update_connection_last_used(connection.id)
    return S3Context(
        connection_id=connection.id,
        connection=connection,
        client=create_s3_client(credentials),
        credentials=credentials,
    )


async def validate_credentials(credentials: S3Credentials) -> dict[str, str | bool]:
    if not credentials.bucket:
        return await validate_credentials_only(
            credentials.access_key_id,
            credentials.secret_access_key,
            credentials.region,
            credentials.endpoint,
        )
    async with create_s3_client(credentials) as client:
        try:
            await client.head_bucket(credentials.bucket)
            return {"valid": True}
        except S3Error as error:
            code = error.code
            if code == "NotFound" or error.status == 404:
                return {"valid": False, "error": "Bucket not found"}
            if code in {"AccessDenied", "Forbidden"} or error.status == 403:
                return {"valid": True}
            if code in {
                "InvalidAccessKeyId",
                "SignatureDoesNotMatch",
                "ExpiredToken",
                "ExpiredTokenException",
            }:
                return {"valid": False, "error": "Invalid credentials"}
            return {"valid": False, "error": format_error_with_code(error)}


async def validate_credentials_only(
    access_key_id: str, secret_access_key: str, region: str, endpoint: str | None = None
) -> dict[str, str | bool]:
    normalized_endpoint = normalize_endpoint(endpoint)
    async with S3Client(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        region=region,
        endpoint_url=normalized_endpoint,
    ) as client:
        try:
            await client.list_buckets()
            return {"valid": True}
        except S3Error as error:
            code = error.code
            if code in {"AccessDenied", "Forbidden"} or error.status == 403:
                # Credentials recognized; user just lacks ListAllMyBuckets.
                return {"valid": True}
            if code in {
                "InvalidAccessKeyId",
                "SignatureDoesNotMatch",
                "ExpiredToken",
                "ExpiredTokenException",
            }:
                return {"valid": False, "error": format_error_with_code(error)}
            return {"valid": False, "error": format_error_with_code(error)}


async def list_user_buckets(client: S3Client) -> list[dict[str, str]]:
    buckets = await client.list_buckets()
    result: list[dict[str, str]] = []
    for entry in buckets:
        if not entry.name:
            continue
        item: dict[str, str] = {"name": entry.name}
        if entry.creation_date is not None:
            iso = isoformat_z(entry.creation_date.astimezone(UTC))
            if iso:
                item["creationDate"] = iso
        result.append(item)
    return result


async def validate_bucket(client: S3Client, bucket: str) -> dict[str, str | bool]:
    try:
        await client.head_bucket(bucket)
        return {"valid": True}
    except S3Error as error:
        code = error.code
        if code == "NotFound" or error.status == 404:
            return {"valid": False, "error": "Bucket not found"}
        if code in {"AccessDenied", "Forbidden"} or error.status == 403:
            return {"valid": True}
        return {"valid": False, "error": format_error_with_code(error)}


def require_bucket(context: S3Context) -> str:
    if not context.credentials.bucket:
        raise HTTPException(
            status_code=400, detail="No bucket selected. Please select a bucket first."
        )
    return context.credentials.bucket
