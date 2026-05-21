from __future__ import annotations

import pytest

from s3browser.async_s3 import KeyToDelete, S3Client, S3Error


async def test_put_head_get_object(s3_client: S3Client, bucket: str):
    body = b"hello versitygw"
    put_result = await s3_client.put_object(bucket, "hello.txt", body, content_type="text/plain")
    assert put_result.etag is not None

    head = await s3_client.head_object(bucket, "hello.txt")
    assert head.content_length == len(body)
    assert head.content_type == "text/plain"
    assert head.etag == put_result.etag

    response = await s3_client.get_object(bucket, "hello.txt")
    chunks: list[bytes] = []
    async for chunk in response.aiter_bytes():
        chunks.append(chunk)
    assert b"".join(chunks) == body
    assert response.content_type == "text/plain"
    assert response.content_length == len(body)


async def test_get_object_range(s3_client: S3Client, bucket: str):
    body = b"0123456789ABCDEF"
    await s3_client.put_object(bucket, "data.bin", body)
    response = await s3_client.get_object(bucket, "data.bin", range_header="bytes=0-3")
    out = b""
    async for chunk in response.aiter_bytes():
        out += chunk
    assert out == b"0123"
    assert response.content_range is not None


async def test_list_objects_v2_with_prefix_and_delimiter(s3_client: S3Client, bucket: str):
    keys = ["a/1.txt", "a/2.txt", "b/3.txt", "root.txt"]
    for key in keys:
        await s3_client.put_object(bucket, key, key.encode())

    listing = await s3_client.list_objects_v2(bucket, prefix="a/")
    listed = sorted(item.key for item in listing.contents)
    assert listed == ["a/1.txt", "a/2.txt"]
    assert listing.is_truncated is False

    with_delim = await s3_client.list_objects_v2(bucket, delimiter="/")
    assert "a/" in with_delim.common_prefixes
    assert "b/" in with_delim.common_prefixes
    root_keys = [item.key for item in with_delim.contents]
    assert "root.txt" in root_keys


async def test_copy_object_preserves_content(s3_client: S3Client, bucket: str):
    await s3_client.put_object(bucket, "src.txt", b"original", content_type="text/plain")
    result = await s3_client.copy_object(bucket, "dst.txt", copy_source=f"{bucket}/src.txt")
    assert result.etag is not None

    response = await s3_client.get_object(bucket, "dst.txt")
    body = b""
    async for chunk in response.aiter_bytes():
        body += chunk
    assert body == b"original"


async def test_delete_object(s3_client: S3Client, bucket: str):
    await s3_client.put_object(bucket, "doomed.txt", b"x")
    await s3_client.delete_object(bucket, "doomed.txt")
    with pytest.raises(S3Error) as info:
        await s3_client.head_object(bucket, "doomed.txt")
    assert info.value.status == 404


async def test_delete_objects_batch(s3_client: S3Client, bucket: str):
    keys = [f"batch/{i}.txt" for i in range(3)]
    for key in keys:
        await s3_client.put_object(bucket, key, b"x")
    result = await s3_client.delete_objects(bucket, [KeyToDelete(key=key) for key in keys])
    deleted_keys = sorted(d.key for d in result.deleted)
    assert deleted_keys == sorted(keys)
    listing = await s3_client.list_objects_v2(bucket, prefix="batch/")
    assert listing.contents == []


async def test_head_object_not_found(s3_client: S3Client, bucket: str):
    with pytest.raises(S3Error) as info:
        await s3_client.head_object(bucket, "missing.txt")
    assert info.value.code in {"NoSuchKey", "NotFound"}
    assert info.value.status == 404


async def test_get_object_not_found(s3_client: S3Client, bucket: str):
    with pytest.raises(S3Error) as info:
        await s3_client.get_object(bucket, "missing.txt")
    assert info.value.status == 404


async def test_keys_with_special_characters(s3_client: S3Client, bucket: str):
    key = "folder name/file (1) #copy.txt"
    body = b"weird name works"
    await s3_client.put_object(bucket, key, body)
    head = await s3_client.head_object(bucket, key)
    assert head.content_length == len(body)
    listing = await s3_client.list_objects_v2(bucket, prefix="folder name/")
    assert any(item.key == key for item in listing.contents)
