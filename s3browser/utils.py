from __future__ import annotations

import base64
import json
import mimetypes
import posixpath
import re
from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import HTTPException


def isoformat_z(value: object) -> str | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def extract_file_name(key: str) -> str:
    clean_key = key[:-1] if key.endswith("/") else key
    return clean_key.split("/")[-1] or clean_key


def has_unsafe_chars(value: str) -> bool:
    return any(ord(char) <= 0x1F or ord(char) == 0x7F or char == "\\" for char in value)


def validate_object_key(value: object, *, message: str = "Object key is required") -> str:
    if not isinstance(value, str) or not value:
        raise HTTPException(status_code=400, detail=message)
    if has_unsafe_chars(value):
        raise HTTPException(
            status_code=400,
            detail="Invalid character in key: control characters and backslashes not allowed",
        )
    if value.startswith("/"):
        raise HTTPException(status_code=400, detail="Absolute paths not allowed")
    normalized = posixpath.normpath(value)
    if normalized.startswith("..") or normalized in {".", ""}:
        raise HTTPException(status_code=400, detail="Directory traversal not allowed")
    if len(normalized.encode("utf-8")) > 1024:
        raise HTTPException(status_code=400, detail="Key exceeds maximum length of 1024 bytes")
    return normalized


def validate_copy_key(value: str, label: str) -> None:
    if not isinstance(value, str) or not value:
        raise HTTPException(
            status_code=400, detail=f"Invalid {label}: Key must be a non-empty string"
        )
    if value.startswith("/") or any(segment == ".." for segment in value.split("/")):
        raise HTTPException(status_code=400, detail=f"Invalid {label}: Invalid object key")
    if len(value.encode("utf-8")) > 1024:
        raise HTTPException(
            status_code=400, detail=f"Invalid {label}: Key exceeds maximum length of 1024 bytes"
        )


def sanitize_folder_path(value: object) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail="Folder path must be a string")
    sanitized = value.strip()
    if any(segment == ".." for segment in sanitized.split("/")):
        raise HTTPException(status_code=400, detail="Path traversal is not allowed")
    sanitized = re.sub(r"^/+", "", sanitized)
    sanitized = re.sub(r"/+", "/", sanitized)
    sanitized = re.sub(r"/+$", "", sanitized)
    if not sanitized:
        raise HTTPException(status_code=400, detail="Folder path cannot be empty")
    if any(not segment for segment in sanitized.split("/")):
        raise HTTPException(status_code=400, detail="Folder path contains empty segments")
    folder_path = f"{sanitized}/"
    if len(folder_path.encode("utf-8")) > 1024:
        raise HTTPException(
            status_code=400, detail="Folder path exceeds maximum length of 1024 bytes"
        )
    return folder_path


def sanitize_version_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed or has_unsafe_chars(trimmed):
        return None
    return trimmed


def encode_version_token(key_marker: str | None, version_id_marker: str | None) -> str | None:
    if not key_marker:
        return None
    payload = json.dumps(
        {"keyMarker": key_marker, "versionIdMarker": version_id_marker}, separators=(",", ":")
    )
    return base64.b64encode(payload.encode("utf-8")).decode("ascii")


def decode_version_token(token: str | None) -> dict[str, str | None]:
    if not token:
        return {}
    try:
        decoded = base64.b64decode(token).decode("utf-8")
        parsed = json.loads(decoded)
    except (ValueError, UnicodeDecodeError):
        return {}
    return {
        "KeyMarker": parsed.get("keyMarker") if isinstance(parsed.get("keyMarker"), str) else None,
        "VersionIdMarker": parsed.get("versionIdMarker")
        if isinstance(parsed.get("versionIdMarker"), str)
        else None,
    }


def validate_content_type(content_type: object) -> str | None:
    if not isinstance(content_type, str) or not content_type:
        return None
    if any(ord(char) <= 0x1F or ord(char) == 0x7F for char in content_type):
        return None
    if len(content_type) > 256:
        return None
    pattern = re.compile(
        r"^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*/"
        r"[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*"
        r"(?:;\s*[a-zA-Z0-9\-_.]+=[a-zA-Z0-9\-_.]+)*$"
    )
    return content_type if pattern.fullmatch(content_type) else None


def sanitize_filename(filename: str) -> str:
    result = ""
    for char in filename:
        code = ord(char)
        if code <= 0x1F or code == 0x7F or char in {'"', ";"}:
            continue
        result += char if code <= 0x7F else "_"
    sanitized = re.sub(r"\s+", " ", result).strip()
    return sanitized or "download"


def build_content_disposition(disposition: str, raw_filename: str) -> str:
    ascii_name = sanitize_filename(raw_filename)
    encoded = quote(raw_filename)
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}"


def guess_mime(path: str) -> str:
    return mimetypes.guess_type(path)[0] or "application/octet-stream"
