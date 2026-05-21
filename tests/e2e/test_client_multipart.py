from __future__ import annotations

import pytest

from s3browser.async_s3 import MultipartPart, S3Client, S3Error

PART_SIZE = 5 * 1024 * 1024


async def test_multipart_upload_full_lifecycle(s3_client: S3Client, bucket: str):
    key = "big-file.bin"
    upload_id = await s3_client.create_multipart_upload(
        bucket, key, content_type="application/octet-stream"
    )
    assert upload_id

    part_a = b"A" * PART_SIZE
    part_b = b"B" * (PART_SIZE // 2)

    etag_a = await s3_client.upload_part(
        bucket, key, upload_id=upload_id, part_number=1, body=part_a
    )
    etag_b = await s3_client.upload_part(
        bucket, key, upload_id=upload_id, part_number=2, body=part_b
    )
    assert etag_a and etag_b

    result = await s3_client.complete_multipart_upload(
        bucket,
        key,
        upload_id=upload_id,
        parts=[
            MultipartPart(part_number=1, etag=etag_a),
            MultipartPart(part_number=2, etag=etag_b),
        ],
    )
    assert result.etag is not None

    head = await s3_client.head_object(bucket, key)
    assert head.content_length == len(part_a) + len(part_b)


async def test_multipart_abort(s3_client: S3Client, bucket: str):
    key = "abort-me.bin"
    upload_id = await s3_client.create_multipart_upload(bucket, key)
    await s3_client.upload_part(
        bucket, key, upload_id=upload_id, part_number=1, body=b"X" * (5 * 1024 * 1024)
    )
    await s3_client.abort_multipart_upload(bucket, key, upload_id=upload_id)

    # After abort the object must not exist.
    with pytest.raises(S3Error) as info:
        await s3_client.head_object(bucket, key)
    assert info.value.status == 404


async def test_upload_part_copy(s3_client: S3Client, bucket: str):
    source_key = "source.bin"
    dest_key = "dest.bin"
    source_body = b"S" * (PART_SIZE + 1024)
    await s3_client.put_object(bucket, source_key, source_body)

    upload_id = await s3_client.create_multipart_upload(bucket, dest_key)
    result = await s3_client.upload_part_copy(
        bucket,
        dest_key,
        upload_id=upload_id,
        part_number=1,
        copy_source=f"{bucket}/{source_key}",
        copy_source_range=f"bytes=0-{PART_SIZE - 1}",
    )
    part_etag = result.etag
    assert part_etag is not None

    # Add a tail part so we satisfy any minimum-part-count constraints.
    tail_etag = await s3_client.upload_part(
        bucket,
        dest_key,
        upload_id=upload_id,
        part_number=2,
        body=source_body[PART_SIZE:],
    )

    completed = await s3_client.complete_multipart_upload(
        bucket,
        dest_key,
        upload_id=upload_id,
        parts=[
            MultipartPart(part_number=1, etag=part_etag),
            MultipartPart(part_number=2, etag=tail_etag),
        ],
    )
    assert completed.etag is not None
