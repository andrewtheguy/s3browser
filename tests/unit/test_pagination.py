from __future__ import annotations

import httpx
import pytest

from s3browser.async_s3 import S3Client

PAGE_1 = b"""<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token-from-page-1</NextContinuationToken>
  <KeyCount>2</KeyCount>
  <Contents><Key>a</Key><Size>1</Size></Contents>
  <Contents><Key>b</Key><Size>2</Size></Contents>
</ListBucketResult>"""

PAGE_2 = b"""<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <KeyCount>1</KeyCount>
  <Contents><Key>c</Key><Size>3</Size></Contents>
</ListBucketResult>"""


@pytest.fixture
def client_and_captured():
    captured: list[httpx.Request] = []
    pages = [PAGE_1, PAGE_2]

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, content=pages.pop(0))

    transport = httpx.MockTransport(handler)
    client = S3Client(
        access_key_id="AKIA",
        secret_access_key="secret",
        region="us-east-1",
        http_client=httpx.AsyncClient(transport=transport),
    )
    return client, captured


async def test_list_objects_v2_two_page_continuation(client_and_captured):
    client, captured = client_and_captured
    async with client:
        first = await client.list_objects_v2("b", prefix="")
        assert first.is_truncated is True
        assert first.next_continuation_token == "token-from-page-1"
        assert [c.key for c in first.contents] == ["a", "b"]
        assert first.next_continuation_token is not None
        second = await client.list_objects_v2("b", continuation_token=first.next_continuation_token)
    assert second.is_truncated is False
    assert second.next_continuation_token is None
    assert [c.key for c in second.contents] == ["c"]
    # second request must include the continuation token
    second_query = str(captured[1].url.query)
    assert "continuation-token=token-from-page-1" in second_query


async def test_list_object_versions_pagination():
    captured: list[httpx.Request] = []
    pages = [
        b"""<?xml version="1.0"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>true</IsTruncated>
  <NextKeyMarker>after-a</NextKeyMarker>
  <NextVersionIdMarker>vid-x</NextVersionIdMarker>
  <Version><Key>a</Key><VersionId>v1</VersionId><IsLatest>true</IsLatest><Size>1</Size></Version>
</ListVersionsResult>""",
        b"""<?xml version="1.0"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Version><Key>b</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest><Size>2</Size></Version>
</ListVersionsResult>""",
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, content=pages.pop(0))

    transport = httpx.MockTransport(handler)
    client = S3Client(
        access_key_id="AKIA",
        secret_access_key="secret",
        region="us-east-1",
        http_client=httpx.AsyncClient(transport=transport),
    )
    async with client:
        first = await client.list_object_versions("b")
        assert first.is_truncated is True
        assert first.next_key_marker == "after-a"
        assert first.next_version_id_marker == "vid-x"
        assert first.next_key_marker is not None and first.next_version_id_marker is not None
        await client.list_object_versions(
            "b",
            key_marker=first.next_key_marker,
            version_id_marker=first.next_version_id_marker,
        )
    second_query = str(captured[1].url.query)
    assert "key-marker=after-a" in second_query
    assert "version-id-marker=vid-x" in second_query
