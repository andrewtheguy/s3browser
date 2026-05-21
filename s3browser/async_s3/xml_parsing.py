from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import UTC, datetime
from xml.sax.saxutils import escape

_NS_RE = re.compile(rb'\sxmlns="[^"]+"', re.IGNORECASE)


def _strip_namespace(content: bytes) -> bytes:
    return _NS_RE.sub(b"", content, count=1)


def _parse_root(content: bytes) -> ET.Element:
    return ET.fromstring(_strip_namespace(content))


def _text(element: ET.Element | None, child: str) -> str | None:
    if element is None:
        return None
    node = element.find(child)
    if node is None or node.text is None:
        return None
    return node.text.strip()


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def _parse_bool(value: str | None) -> bool:
    return (value or "").lower() == "true"


def _parse_int(value: str | None) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except ValueError:
        return None


@dataclass
class ObjectInfo:
    key: str
    last_modified: datetime | None
    size: int | None
    etag: str | None
    storage_class: str | None
    checksum_algorithm: list[str] = field(default_factory=list)
    checksum_type: str | None = None


@dataclass
class ObjectVersion:
    key: str
    version_id: str | None
    is_latest: bool
    last_modified: datetime | None
    size: int | None
    etag: str | None
    storage_class: str | None
    is_delete_marker: bool


@dataclass
class ListObjectsResult:
    contents: list[ObjectInfo]
    common_prefixes: list[str]
    is_truncated: bool
    next_continuation_token: str | None
    key_count: int | None


@dataclass
class ListVersionsResult:
    versions: list[ObjectVersion]
    common_prefixes: list[str]
    is_truncated: bool
    next_key_marker: str | None
    next_version_id_marker: str | None


@dataclass
class BucketSummary:
    name: str
    creation_date: datetime | None


@dataclass
class DeleteResultEntry:
    key: str
    version_id: str | None
    delete_marker: bool
    delete_marker_version_id: str | None


@dataclass
class DeleteResultError:
    key: str
    code: str
    message: str
    version_id: str | None


@dataclass
class DeleteObjectsResult:
    deleted: list[DeleteResultEntry]
    errors: list[DeleteResultError]


@dataclass
class CopyResult:
    etag: str | None
    last_modified: datetime | None


@dataclass
class CompleteMultipartResult:
    location: str | None
    bucket: str | None
    key: str | None
    etag: str | None


@dataclass
class BucketVersioning:
    status: str | None
    mfa_delete: str | None


@dataclass
class ServerSideEncryptionRule:
    sse_algorithm: str | None
    kms_master_key_id: str | None
    bucket_key_enabled: bool | None


@dataclass
class BucketEncryption:
    rules: list[ServerSideEncryptionRule]


@dataclass
class LifecycleTransition:
    days: int | None
    date: datetime | None
    storage_class: str | None


@dataclass
class LifecycleExpiration:
    days: int | None
    date: datetime | None
    expired_object_delete_marker: bool | None


@dataclass
class LifecycleRule:
    id: str | None
    status: str | None
    prefix: str | None
    filter_prefix: str | None
    expiration: LifecycleExpiration | None
    transitions: list[LifecycleTransition]
    noncurrent_expiration_days: int | None
    abort_incomplete_multipart_days: int | None


def parse_list_objects_v2(content: bytes) -> ListObjectsResult:
    root = _parse_root(content)
    contents: list[ObjectInfo] = []
    for element in root.findall("Contents"):
        algos: list[str] = []
        for algo in element.findall("ChecksumAlgorithm"):
            if algo.text:
                algos.append(algo.text.strip())
        contents.append(
            ObjectInfo(
                key=_text(element, "Key") or "",
                last_modified=_parse_dt(_text(element, "LastModified")),
                size=_parse_int(_text(element, "Size")),
                etag=_text(element, "ETag"),
                storage_class=_text(element, "StorageClass"),
                checksum_algorithm=algos,
                checksum_type=_text(element, "ChecksumType"),
            )
        )
    common_prefixes: list[str] = [
        prefix.text.strip() for prefix in root.findall("CommonPrefixes/Prefix") if prefix.text
    ]
    return ListObjectsResult(
        contents=contents,
        common_prefixes=common_prefixes,
        is_truncated=_parse_bool(_text(root, "IsTruncated")),
        next_continuation_token=_text(root, "NextContinuationToken"),
        key_count=_parse_int(_text(root, "KeyCount")),
    )


def parse_list_object_versions(content: bytes) -> ListVersionsResult:
    root = _parse_root(content)
    versions: list[ObjectVersion] = []
    for element in root.findall("Version"):
        versions.append(
            ObjectVersion(
                key=_text(element, "Key") or "",
                version_id=_text(element, "VersionId"),
                is_latest=_parse_bool(_text(element, "IsLatest")),
                last_modified=_parse_dt(_text(element, "LastModified")),
                size=_parse_int(_text(element, "Size")),
                etag=_text(element, "ETag"),
                storage_class=_text(element, "StorageClass"),
                is_delete_marker=False,
            )
        )
    for element in root.findall("DeleteMarker"):
        versions.append(
            ObjectVersion(
                key=_text(element, "Key") or "",
                version_id=_text(element, "VersionId"),
                is_latest=_parse_bool(_text(element, "IsLatest")),
                last_modified=_parse_dt(_text(element, "LastModified")),
                size=None,
                etag=None,
                storage_class=None,
                is_delete_marker=True,
            )
        )
    common_prefixes: list[str] = [
        prefix.text.strip() for prefix in root.findall("CommonPrefixes/Prefix") if prefix.text
    ]
    return ListVersionsResult(
        versions=versions,
        common_prefixes=common_prefixes,
        is_truncated=_parse_bool(_text(root, "IsTruncated")),
        next_key_marker=_text(root, "NextKeyMarker"),
        next_version_id_marker=_text(root, "NextVersionIdMarker"),
    )


def parse_list_buckets(content: bytes) -> list[BucketSummary]:
    root = _parse_root(content)
    return [
        BucketSummary(
            name=_text(element, "Name") or "",
            creation_date=_parse_dt(_text(element, "CreationDate")),
        )
        for element in root.findall("Buckets/Bucket")
    ]


def parse_create_multipart(content: bytes) -> str:
    root = _parse_root(content)
    upload_id = _text(root, "UploadId")
    if not upload_id:
        raise ValueError("InitiateMultipartUploadResult missing UploadId")
    return upload_id


def parse_complete_multipart(content: bytes) -> CompleteMultipartResult:
    root = _parse_root(content)
    return CompleteMultipartResult(
        location=_text(root, "Location"),
        bucket=_text(root, "Bucket"),
        key=_text(root, "Key"),
        etag=_text(root, "ETag"),
    )


def parse_copy_object(content: bytes) -> CopyResult:
    root = _parse_root(content)
    return CopyResult(
        etag=_text(root, "ETag"),
        last_modified=_parse_dt(_text(root, "LastModified")),
    )


def parse_upload_part_copy(content: bytes) -> CopyResult:
    return parse_copy_object(content)


def parse_delete_objects(content: bytes) -> DeleteObjectsResult:
    root = _parse_root(content)
    deleted: list[DeleteResultEntry] = []
    for element in root.findall("Deleted"):
        deleted.append(
            DeleteResultEntry(
                key=_text(element, "Key") or "",
                version_id=_text(element, "VersionId"),
                delete_marker=_parse_bool(_text(element, "DeleteMarker")),
                delete_marker_version_id=_text(element, "DeleteMarkerVersionId"),
            )
        )
    errors: list[DeleteResultError] = []
    for element in root.findall("Error"):
        errors.append(
            DeleteResultError(
                key=_text(element, "Key") or "",
                code=_text(element, "Code") or "",
                message=_text(element, "Message") or "",
                version_id=_text(element, "VersionId"),
            )
        )
    return DeleteObjectsResult(deleted=deleted, errors=errors)


def parse_bucket_location(content: bytes) -> str | None:
    root = _parse_root(content)
    if root.tag.endswith("LocationConstraint"):
        return (root.text or "").strip() or None
    return _text(root, "LocationConstraint")


def parse_bucket_versioning(content: bytes) -> BucketVersioning:
    root = _parse_root(content)
    return BucketVersioning(
        status=_text(root, "Status"),
        mfa_delete=_text(root, "MfaDelete"),
    )


def parse_bucket_encryption(content: bytes) -> BucketEncryption:
    root = _parse_root(content)
    rules: list[ServerSideEncryptionRule] = []
    for rule in root.findall("Rule"):
        apply_node = rule.find("ApplyServerSideEncryptionByDefault")
        bucket_key_text = _text(rule, "BucketKeyEnabled")
        bucket_key_enabled = None if bucket_key_text is None else bucket_key_text.lower() == "true"
        rules.append(
            ServerSideEncryptionRule(
                sse_algorithm=_text(apply_node, "SSEAlgorithm") if apply_node is not None else None,
                kms_master_key_id=_text(apply_node, "KMSMasterKeyID")
                if apply_node is not None
                else None,
                bucket_key_enabled=bucket_key_enabled,
            )
        )
    return BucketEncryption(rules=rules)


def parse_bucket_lifecycle(content: bytes) -> list[LifecycleRule]:
    root = _parse_root(content)
    rules: list[LifecycleRule] = []
    for rule in root.findall("Rule"):
        filter_node = rule.find("Filter")
        expiration_node = rule.find("Expiration")
        expiration: LifecycleExpiration | None = None
        if expiration_node is not None:
            expiration_marker = _text(expiration_node, "ExpiredObjectDeleteMarker")
            expiration = LifecycleExpiration(
                days=_parse_int(_text(expiration_node, "Days")),
                date=_parse_dt(_text(expiration_node, "Date")),
                expired_object_delete_marker=None
                if expiration_marker is None
                else expiration_marker.lower() == "true",
            )
        transitions: list[LifecycleTransition] = []
        for transition in rule.findall("Transition"):
            transitions.append(
                LifecycleTransition(
                    days=_parse_int(_text(transition, "Days")),
                    date=_parse_dt(_text(transition, "Date")),
                    storage_class=_text(transition, "StorageClass"),
                )
            )
        noncurrent_node = rule.find("NoncurrentVersionExpiration")
        abort_node = rule.find("AbortIncompleteMultipartUpload")
        rules.append(
            LifecycleRule(
                id=_text(rule, "ID"),
                status=_text(rule, "Status"),
                prefix=_text(rule, "Prefix"),
                filter_prefix=_text(filter_node, "Prefix") if filter_node is not None else None,
                expiration=expiration,
                transitions=transitions,
                noncurrent_expiration_days=_parse_int(
                    _text(noncurrent_node, "NoncurrentDays")
                    if noncurrent_node is not None
                    else None
                ),
                abort_incomplete_multipart_days=_parse_int(
                    _text(abort_node, "DaysAfterInitiation") if abort_node is not None else None
                ),
            )
        )
    return rules


@dataclass
class KeyToDelete:
    key: str
    version_id: str | None = None


def build_delete_objects_body(keys: list[KeyToDelete], *, quiet: bool = False) -> bytes:
    parts: list[str] = ['<?xml version="1.0" encoding="UTF-8"?>', "<Delete>"]
    if quiet:
        parts.append("<Quiet>true</Quiet>")
    for entry in keys:
        parts.append("<Object>")
        parts.append(f"<Key>{escape(entry.key)}</Key>")
        if entry.version_id:
            parts.append(f"<VersionId>{escape(entry.version_id)}</VersionId>")
        parts.append("</Object>")
    parts.append("</Delete>")
    return "".join(parts).encode("utf-8")


@dataclass
class MultipartPart:
    part_number: int
    etag: str


def build_complete_multipart_body(parts: list[MultipartPart]) -> bytes:
    pieces: list[str] = ['<?xml version="1.0" encoding="UTF-8"?>', "<CompleteMultipartUpload>"]
    for part in parts:
        pieces.append("<Part>")
        pieces.append(f"<PartNumber>{part.part_number}</PartNumber>")
        pieces.append(f"<ETag>{escape(part.etag)}</ETag>")
        pieces.append("</Part>")
    pieces.append("</CompleteMultipartUpload>")
    return "".join(pieces).encode("utf-8")
