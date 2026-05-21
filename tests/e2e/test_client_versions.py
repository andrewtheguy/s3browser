from __future__ import annotations

import pytest

from s3browser.async_s3 import S3Client, S3Error


async def _enable_versioning(client: S3Client, bucket: str) -> bool:
    body = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        b"<Status>Enabled</Status>"
        b"</VersioningConfiguration>"
    )
    try:
        await client._request(
            method="PUT",
            bucket=bucket,
            query={"versioning": ""},
            body=body,
            extra_headers={"content-type": "application/xml"},
        )
    except S3Error as error:
        # VersityGW may not implement PutBucketVersioning; skip cleanly.
        if error.code in {"NotImplemented", "MethodNotAllowed", "VersioningNotConfigured"}:
            return False
        raise
    return True


async def test_list_object_versions_after_two_puts(s3_client: S3Client, bucket: str):
    if not await _enable_versioning(s3_client, bucket):
        pytest.skip("Bucket versioning not supported by gateway")

    await s3_client.put_object(bucket, "doc.txt", b"first")
    await s3_client.put_object(bucket, "doc.txt", b"second")

    listing = await s3_client.list_object_versions(bucket, prefix="doc.txt")
    versions = [v for v in listing.versions if v.key == "doc.txt" and not v.is_delete_marker]
    assert len(versions) >= 2


async def test_delete_with_version_id_keeps_other_versions(s3_client: S3Client, bucket: str):
    if not await _enable_versioning(s3_client, bucket):
        pytest.skip("Bucket versioning not supported by gateway")

    await s3_client.put_object(bucket, "doc.txt", b"v1")
    await s3_client.put_object(bucket, "doc.txt", b"v2")

    listing = await s3_client.list_object_versions(bucket, prefix="doc.txt")
    versions = [v for v in listing.versions if not v.is_delete_marker]
    assert len(versions) >= 2

    target = versions[-1]
    assert target.version_id is not None
    await s3_client.delete_object(bucket, "doc.txt", version_id=target.version_id)

    after = await s3_client.list_object_versions(bucket, prefix="doc.txt")
    remaining = [v for v in after.versions if not v.is_delete_marker]
    assert all(v.version_id != target.version_id for v in remaining)
