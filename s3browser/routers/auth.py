from __future__ import annotations

import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from s3browser.auth import AUTH_COOKIE_NAME, create_auth_token, verify_auth_token
from s3browser.config import get_login_password
from s3browser.db import (
    S3Connection,
    decrypt_connection_secret_key,
    delete_connection_by_id,
    get_all_connections,
    get_connection_by_id,
    is_unique_constraint_error,
    save_connection,
)
from s3browser.dependencies import get_s3_context
from s3browser.s3 import (
    S3Context,
    S3Credentials,
    clear_bucket_region_cache,
    detect_s3_vendor,
    get_bucket_region,
    get_effective_endpoint_host,
    list_user_buckets,
    normalize_endpoint,
    validate_bucket,
    validate_credentials,
    validate_credentials_only,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str | None = None


class ConnectionRequest(BaseModel):
    connectionId: int | None = None
    accessKeyId: str | None = None
    secretAccessKey: str | None = None
    region: str | None = None
    bucket: str | None = None
    endpoint: str | None = None
    profileName: str | None = None
    autoDetectRegion: bool | None = None


class SelectBucketRequest(BaseModel):
    bucket: str | None = None


class ExportProfileRequest(BaseModel):
    format: str = Field(pattern="^(aws|rclone)$")


def _search_enabled(endpoint: str | None) -> bool:
    from s3browser.config import get_search_whitelist_hosts

    host = get_effective_endpoint_host(endpoint)
    return host is not None and host in get_search_whitelist_hosts()


def _serialize_connection(connection: S3Connection) -> dict[str, object]:
    return {
        "id": connection.id,
        "profileName": connection.profile_name,
        "endpoint": connection.endpoint,
        "accessKeyId": connection.access_key_id,
        "bucket": connection.bucket,
        "region": connection.region,
        "autoDetectRegion": connection.auto_detect_region == 1,
        "lastUsedAt": connection.last_used_at * 1000,
        "searchEnabled": _search_enabled(connection.endpoint),
    }


def _sanitize_profile_name(name: str, fallback: str) -> str:
    base = name.strip() or fallback
    return re.sub(r"[^a-zA-Z0-9+=,.@_-]", "_", base)


def _sanitize_filename(name: str) -> str:
    trimmed = name.strip()
    if not trimmed:
        return "s3-connection"
    result = ""
    for char in trimmed:
        code = ord(char)
        if (
            code <= 0x1F
            or code == 0x7F
            or char in {"\\", "/", ":", "*", "?", '"', "<", ">", "|"}
            or char.isspace()
        ):
            result += "_"
        else:
            result += char
    sanitized = re.sub(r"[. ]+$", "", result)
    if sanitized.upper() in {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "COM1",
        "COM2",
        "COM3",
        "COM4",
        "COM5",
        "COM6",
        "COM7",
        "COM8",
        "COM9",
        "LPT1",
        "LPT2",
        "LPT3",
        "LPT4",
        "LPT5",
        "LPT6",
        "LPT7",
        "LPT8",
        "LPT9",
    }:
        sanitized = f"_{sanitized}"
    return sanitized or "s3-connection"


def _build_aws_profile(
    profile_name: str, access_key_id: str, secret_access_key: str, region: str, endpoint: str | None
) -> str:
    header = "[default]" if profile_name == "default" else f"[profile {profile_name}]"
    lines = [header, f"region = {region}", "output = json"]
    if endpoint:
        lines.append(f"endpoint_url = {endpoint}")
    lines.extend(
        [f"aws_access_key_id = {access_key_id}", f"aws_secret_access_key = {secret_access_key}", ""]
    )
    return "\n".join(lines)


def _build_rclone_profile(
    profile_name: str,
    access_key_id: str,
    secret_access_key: str,
    region: str | None,
    provider: str,
    endpoint: str | None,
) -> str:
    lines = [
        f"[{profile_name}]",
        "type = s3",
        f"provider = {provider}",
        f"access_key_id = {access_key_id}",
        f"secret_access_key = {secret_access_key}",
    ]
    if region:
        lines.append(f"region = {region}")
    if endpoint:
        lines.append(f"endpoint = {endpoint}")
    lines.append("")
    return "\n".join(lines)


@router.post("/login")
async def login(body: LoginRequest, request: Request, response: Response) -> dict[str, bool]:
    if not body.password:
        raise HTTPException(status_code=400, detail="Password is required")
    if not secrets.compare_digest(body.password, get_login_password()):
        raise HTTPException(status_code=401, detail="Invalid password")
    response.set_cookie(
        AUTH_COOKIE_NAME,
        create_auth_token(),
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )
    return {"success": True}


@router.post("/logout")
async def logout(response: Response) -> dict[str, bool]:
    clear_bucket_region_cache()
    response.delete_cookie(AUTH_COOKIE_NAME, path="/")
    return {"success": True}


@router.get("/status")
async def status(request: Request, response: Response) -> dict[str, bool]:
    token = request.cookies.get(AUTH_COOKIE_NAME)
    authenticated = verify_auth_token(token)
    if not authenticated:
        response.delete_cookie(AUTH_COOKIE_NAME, path="/")
    return {"authenticated": authenticated}


@router.post("/connections")
async def save_s3_connection(body: ConnectionRequest) -> dict[str, object]:
    if not body.accessKeyId:
        raise HTTPException(status_code=400, detail="Access key ID is required")
    if not body.profileName or not body.profileName.strip():
        raise HTTPException(status_code=400, detail="Profile name is required")
    existing = None
    if body.connectionId is not None:
        if body.connectionId <= 0:
            raise HTTPException(status_code=400, detail="Invalid connection ID")
        existing = get_connection_by_id(body.connectionId)
        if existing is None:
            raise HTTPException(status_code=404, detail="Connection not found")
    if body.secretAccessKey:
        effective_secret = body.secretAccessKey
    elif existing is not None:
        effective_secret = decrypt_connection_secret_key(existing)
    else:
        raise HTTPException(
            status_code=400, detail="Secret access key is required for new connections"
        )
    detected_region = body.region
    if body.bucket:
        if not detected_region:
            try:
                detected_region = await get_bucket_region(
                    body.accessKeyId, effective_secret, body.bucket, body.endpoint
                )
            except RuntimeError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error
    else:
        detected_region = detected_region or "us-east-1"
    credentials = S3Credentials(
        access_key_id=body.accessKeyId,
        secret_access_key=effective_secret,
        region=detected_region,
        bucket=body.bucket,
        endpoint=body.endpoint,
    )
    validation = (
        await validate_credentials(credentials)
        if body.bucket
        else await validate_credentials_only(
            body.accessKeyId, effective_secret, detected_region, body.endpoint
        )
    )
    if not validation.get("valid"):
        raise HTTPException(
            status_code=401, detail=str(validation.get("error") or "Invalid credentials")
        )
    try:
        saved = save_connection(
            body.connectionId,
            body.profileName.strip(),
            body.endpoint or "",
            body.accessKeyId,
            body.secretAccessKey or None,
            body.bucket or None,
            detected_region,
            body.autoDetectRegion is not False,
        )
    except Exception as error:
        if is_unique_constraint_error(error):
            raise HTTPException(status_code=400, detail="Profile name already exists") from error
        raise HTTPException(status_code=500, detail="Failed to save connection") from error
    return {
        "success": True,
        "connectionId": saved.id,
        "region": detected_region,
        "bucket": body.bucket or None,
        "endpoint": body.endpoint or None,
        "searchEnabled": _search_enabled(body.endpoint),
    }


@router.get("/connections")
async def list_connections(request: Request) -> dict[str, object]:
    if request.query_params.get("clear_region_cache") in {"1", "true"}:
        clear_bucket_region_cache()
    return {
        "connections": [_serialize_connection(connection) for connection in get_all_connections()]
    }


@router.get("/connections/{connection_id}")
async def get_connection(connection_id: int) -> dict[str, object]:
    if connection_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid connection ID")
    connection = get_connection_by_id(connection_id)
    if connection is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    return _serialize_connection(connection)


@router.delete("/connections/{connection_id}")
async def delete_connection(connection_id: int) -> dict[str, bool]:
    if connection_id <= 0:
        raise HTTPException(status_code=400, detail="Valid connection ID is required")
    if not delete_connection_by_id(connection_id):
        raise HTTPException(status_code=404, detail="Connection not found")
    return {"success": True}


@router.get("/buckets/{connection_id}")
async def list_buckets(
    request: Request, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    if request.query_params.get("clear_region_cache") in {"1", "true"}:
        clear_bucket_region_cache()
    try:
        return {"buckets": await list_user_buckets(context.client)}
    except Exception as error:
        message = str(error)
        lower = message.lower()
        if "signature" in lower or "credential" in lower or "invalidaccesskeyid" in lower:
            raise HTTPException(status_code=401, detail="Authentication failed") from error
        if "accessdenied" in lower or "forbidden" in lower:
            raise HTTPException(status_code=403, detail="Access denied") from error
        raise HTTPException(status_code=500, detail=message or "Failed to list buckets") from error


@router.post("/validate-bucket/{connection_id}")
async def validate_bucket_for_connection(
    body: SelectBucketRequest, context: S3Context = Depends(get_s3_context)
) -> dict[str, object]:
    if not body.bucket:
        raise HTTPException(status_code=400, detail="Bucket name is required")
    validation = await validate_bucket(context.client, body.bucket)
    if not validation.get("valid"):
        raise HTTPException(
            status_code=400, detail=str(validation.get("error") or "Invalid bucket")
        )
    return {"success": True, "bucket": body.bucket}


@router.post("/test-connection")
async def test_connection(body: ConnectionRequest) -> dict[str, bool]:
    if not body.accessKeyId or not body.secretAccessKey:
        raise HTTPException(status_code=400, detail="Missing required credentials")
    region = body.region or "us-east-1"
    validation = (
        await validate_credentials(
            S3Credentials(
                access_key_id=body.accessKeyId,
                secret_access_key=body.secretAccessKey,
                region=region,
                bucket=body.bucket,
                endpoint=body.endpoint,
            )
        )
        if body.bucket
        else await validate_credentials_only(
            body.accessKeyId, body.secretAccessKey, region, body.endpoint
        )
    )
    if not validation.get("valid"):
        raise HTTPException(
            status_code=401, detail=str(validation.get("error") or "Invalid credentials")
        )
    return {"success": True}


@router.post("/connections/{connection_id}/export")
async def export_connection(
    connection_id: int, body: ExportProfileRequest, response: Response
) -> dict[str, str]:
    if connection_id <= 0:
        raise HTTPException(status_code=400, detail="Valid connection ID is required")
    connection = get_connection_by_id(connection_id)
    if connection is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    response.headers["Cache-Control"] = "no-store"
    secret = decrypt_connection_secret_key(connection)
    profile_name = _sanitize_profile_name(connection.profile_name, f"connection-{connection.id}")
    filename_base = _sanitize_filename(profile_name)
    endpoint = normalize_endpoint(connection.endpoint)
    region = connection.region or "us-east-1"
    if body.format == "aws":
        endpoint_for_aws = None if detect_s3_vendor(endpoint) == "aws" else endpoint
        return {
            "filename": f"{filename_base}.aws-config",
            "content": _build_aws_profile(
                profile_name, connection.access_key_id, secret, region, endpoint_for_aws
            ),
        }
    provider = (
        "Backblaze"
        if detect_s3_vendor(endpoint) == "b2"
        else "AWS"
        if detect_s3_vendor(endpoint) == "aws"
        else "Other"
    )
    return {
        "filename": f"{filename_base}.rclone.conf",
        "content": _build_rclone_profile(
            profile_name, connection.access_key_id, secret, region, provider, endpoint
        ),
    }
