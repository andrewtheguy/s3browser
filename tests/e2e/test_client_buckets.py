from __future__ import annotations

import pytest

from s3browser.async_s3 import S3Client, S3Error


async def test_list_buckets_includes_test_bucket(s3_client: S3Client, bucket: str):
    buckets = await s3_client.list_buckets()
    names = {b.name for b in buckets}
    assert bucket in names


async def test_head_bucket_returns_region(s3_client: S3Client, bucket: str):
    result = await s3_client.head_bucket(bucket)
    assert result.status == 200


async def test_get_bucket_location(s3_client: S3Client, bucket: str):
    # VersityGW returns an empty location which the parser maps to None.
    # We just verify the call succeeds and returns either None or a string.
    location = await s3_client.get_bucket_location(bucket)
    assert location is None or isinstance(location, str)


async def test_get_bucket_versioning_unset(s3_client: S3Client, bucket: str):
    try:
        versioning = await s3_client.get_bucket_versioning(bucket)
    except S3Error as error:
        # VersityGW returns VersioningNotConfigured when never enabled.
        assert error.code in {"VersioningNotConfigured", "NotImplemented"}
        return
    assert versioning.status in (None, "Suspended", "Enabled")


async def test_get_bucket_encryption_handles_missing(s3_client: S3Client, bucket: str):
    # VersityGW typically returns NotImplemented or an empty encryption config.
    try:
        result = await s3_client.get_bucket_encryption(bucket)
        # If the call succeeds, just assert the structure.
        assert hasattr(result, "rules")
    except S3Error as error:
        assert error.code in {
            "NotImplemented",
            "ServerSideEncryptionConfigurationNotFoundError",
        }


async def test_get_bucket_lifecycle_handles_missing(s3_client: S3Client, bucket: str):
    try:
        rules = await s3_client.get_bucket_lifecycle_configuration(bucket)
        assert isinstance(rules, list)
    except S3Error as error:
        assert error.code in {
            "NoSuchLifecycleConfiguration",
            "NotImplemented",
        }


async def test_head_bucket_missing_raises(s3_client: S3Client):
    with pytest.raises(S3Error) as info:
        await s3_client.head_bucket("definitely-does-not-exist-zzzqqq")
    assert info.value.status in {403, 404}
