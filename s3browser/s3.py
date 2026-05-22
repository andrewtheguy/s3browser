from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from aiobotocore.session import AioSession, get_session
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException

from s3browser.db import S3Connection, decrypt_connection_secret_key, update_connection_last_used

S3Vendor = str

_session: AioSession = get_session()
# Force regional STS endpoint (matches JS `useGlobalEndpoint: false`) so AWS callers
# outside us-east-1 don't hit the global sts.amazonaws.com that only works there.
_session.set_config_variable("sts_regional_endpoints", "regional")
_bucket_region_cache: dict[str, str] = {}
_region_detection_in_flight: dict[str, asyncio.Future[str]] = {}


@dataclass(frozen=True)
class S3Credentials:
    access_key_id: str
    secret_access_key: str
    region: str
    bucket: str | None = None
    endpoint: str | None = None


@dataclass(frozen=True)
class S3Context:
    connection_id: int
    connection: S3Connection
    client: Any
    credentials: S3Credentials


def clear_bucket_region_cache() -> None:
    _bucket_region_cache.clear()
    print("[s3browser] Bucket region cache cleared")


async def _detect_bucket_region_deduped(
    cache_key: str,
    access_key_id: str,
    secret_access_key: str,
    bucket: str,
    endpoint: str | None,
) -> str:
    existing = _region_detection_in_flight.get(cache_key)
    if existing is not None:
        return await existing
    loop = asyncio.get_running_loop()
    future: asyncio.Future[str] = loop.create_future()
    _region_detection_in_flight[cache_key] = future
    try:
        region = await get_bucket_region(access_key_id, secret_access_key, bucket, endpoint)
    except BaseException as error:
        if not future.done():
            future.set_exception(error)
        raise
    else:
        if not future.done():
            future.set_result(region)
        return region
    finally:
        if _region_detection_in_flight.get(cache_key) is future:
            del _region_detection_in_flight[cache_key]


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
    if isinstance(error, ClientError):
        code = str(error.response.get("Error", {}).get("Code", "")).lower()
        return code in {"accessdenied", "forbidden"}
    message = str(error).lower()
    return "accessdenied" in message or "forbidden" in message


def is_not_found(error: object) -> bool:
    if isinstance(error, ClientError):
        code = str(error.response.get("Error", {}).get("Code", "")).lower()
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return code in {"nosuchkey", "notfound", "404"} or status == 404
    return False


def error_code(error: object) -> str:
    if isinstance(error, ClientError):
        return str(error.response.get("Error", {}).get("Code", ""))
    return getattr(error, "name", "") or error.__class__.__name__


def http_status_code(error: object) -> int | None:
    if isinstance(error, ClientError):
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if isinstance(status, int):
            return status
    return None


def error_message(error: object) -> str:
    if isinstance(error, ClientError):
        return str(error.response.get("Error", {}).get("Message") or "")
    return str(error)


def format_error_with_code(error: object) -> str:
    if isinstance(error, ClientError):
        code = error.response.get("Error", {}).get("Code")
        message = error.response.get("Error", {}).get("Message") or str(error)
        return f"{code}: {message}" if code and str(code) not in message else message
    return str(error) or "Unknown error"


def _client_config(endpoint: str | None = None) -> Config:
    # Match AWS SDK v3 presigning behavior and avoid botocore's legacy SigV2 query URLs.
    if endpoint:
        return Config(signature_version="s3v4", s3={"addressing_style": "path"})
    return Config(signature_version="s3v4")


@asynccontextmanager
async def _create_aio_client(service: str, **kwargs: Any) -> AsyncIterator[Any]:
    async with _session.create_client(service, **kwargs) as client:
        yield client


@asynccontextmanager
async def create_s3_client(credentials: S3Credentials) -> AsyncIterator[Any]:
    endpoint = normalize_endpoint(credentials.endpoint)
    kwargs: dict[str, Any] = {
        "region_name": credentials.region,
        "aws_access_key_id": credentials.access_key_id,
        "aws_secret_access_key": credentials.secret_access_key,
        "config": _client_config(endpoint),
    }
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    async with _create_aio_client("s3", **kwargs) as client:
        yield client


async def get_bucket_region(
    access_key_id: str, secret_access_key: str, bucket: str, endpoint: str | None = None
) -> str:
    if endpoint:
        return "us-east-1"
    async with _create_aio_client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
    ) as client:
        try:
            response = await client.get_bucket_location(Bucket=bucket)
        except (BotoCoreError, ClientError) as error:
            print(f"Failed to get bucket location: {error}")
            raise RuntimeError(
                "Failed to detect bucket region. Please specify the region manually."
            ) from error
    location = response.get("LocationConstraint")
    if not location:
        return "us-east-1"
    if location == "EU":
        return "eu-west-1"
    return str(location)


@asynccontextmanager
async def create_s3_context_from_connection(
    connection: S3Connection, bucket: str | None = None
) -> AsyncIterator[S3Context]:
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
                region = await _detect_bucket_region_deduped(
                    cache_key,
                    connection.access_key_id,
                    secret,
                    effective_bucket,
                    endpoint,
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
    async with create_s3_client(credentials) as client:
        yield S3Context(
            connection_id=connection.id,
            connection=connection,
            client=client,
            credentials=credentials,
        )


async def validate_credentials(credentials: S3Credentials) -> dict[str, str | bool]:
    async with create_s3_client(credentials) as client:
        try:
            await client.head_bucket(Bucket=credentials.bucket)
            return {"valid": True}
        except (BotoCoreError, ClientError) as error:
            code = error_code(error)
            if code == "NotFound":
                return {"valid": False, "error": "Bucket not found"}
            if code in {"AccessDenied", "Forbidden"}:
                return {"valid": True}
            if code in {"InvalidAccessKeyId", "SignatureDoesNotMatch"}:
                return {"valid": False, "error": "Invalid credentials"}
            return {"valid": False, "error": format_error_with_code(error)}


async def validate_credentials_only(
    access_key_id: str, secret_access_key: str, region: str, endpoint: str | None = None
) -> dict[str, str | bool]:
    normalized_endpoint = normalize_endpoint(endpoint)
    if normalized_endpoint:
        async with create_s3_client(
            S3Credentials(
                access_key_id=access_key_id,
                secret_access_key=secret_access_key,
                region=region,
                endpoint=normalized_endpoint,
            )
        ) as client:
            try:
                await client.list_buckets()
                return {"valid": True}
            except (BotoCoreError, ClientError) as error:
                code = error_code(error)
                message = format_error_with_code(error)
                if code in {"AccessDenied", "Forbidden"}:
                    return {"valid": True}
                if code in {
                    "InvalidAccessKeyId",
                    "SignatureDoesNotMatch",
                    "ExpiredToken",
                    "ExpiredTokenException",
                }:
                    return {"valid": False, "error": message}
                return {"valid": False, "error": message}
    async with _create_aio_client(
        "sts",
        region_name=region,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
    ) as sts:
        try:
            await sts.get_caller_identity()
            return {"valid": True}
        except (BotoCoreError, ClientError) as error:
            code = error_code(error)
            if code in {"AccessDenied", "Forbidden"}:
                async with create_s3_client(
                    S3Credentials(
                        access_key_id=access_key_id,
                        secret_access_key=secret_access_key,
                        region=region,
                    )
                ) as s3_client:
                    try:
                        await s3_client.list_buckets()
                        return {"valid": True}
                    except (BotoCoreError, ClientError) as s3_error:
                        if error_code(s3_error) in {"AccessDenied", "Forbidden"}:
                            return {"valid": True}
                        return {
                            "valid": False,
                            "error": "STS blocked by policy and S3 check failed: "
                            f"{format_error_with_code(s3_error)}",
                        }
            return {"valid": False, "error": format_error_with_code(error)}


async def list_user_buckets(client: Any) -> list[dict[str, str]]:
    response = await client.list_buckets()
    buckets: list[dict[str, str]] = []
    for bucket in response.get("Buckets", []):
        name = bucket.get("Name")
        if not name:
            continue
        item = {"name": str(name)}
        creation_date = bucket.get("CreationDate")
        if isinstance(creation_date, datetime):
            item["creationDate"] = creation_date.astimezone(UTC).isoformat().replace("+00:00", "Z")
        buckets.append(item)
    return buckets


async def validate_bucket(client: Any, bucket: str) -> dict[str, str | bool]:
    try:
        await client.head_bucket(Bucket=bucket)
        return {"valid": True}
    except (BotoCoreError, ClientError) as error:
        code = error_code(error)
        if code == "NotFound":
            return {"valid": False, "error": "Bucket not found"}
        if code in {"AccessDenied", "Forbidden"}:
            return {"valid": True}
        return {"valid": False, "error": format_error_with_code(error)}


def require_bucket(context: S3Context) -> str:
    if not context.credentials.bucket:
        raise HTTPException(
            status_code=400, detail="No bucket selected. Please select a bucket first."
        )
    return context.credentials.bucket
