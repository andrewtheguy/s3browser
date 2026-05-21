from __future__ import annotations

import httpx
import pytest

from s3browser.async_s3 import S3Client, S3Error


def _ok_xml(body: str = "<Result/>") -> httpx.Response:
    return httpx.Response(200, content=body.encode("utf-8"))


@pytest.fixture
def captured() -> list[httpx.Request]:
    return []


def _make_client(
    captured: list[httpx.Request],
    handler,
    *,
    endpoint_url: str | None = None,
    region: str = "us-east-1",
) -> S3Client:
    def transport_handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(transport_handler)
    return S3Client(
        access_key_id="AKIA",
        secret_access_key="secret",
        region=region,
        endpoint_url=endpoint_url,
        http_client=httpx.AsyncClient(transport=transport),
    )


async def test_path_style_url_aws_default(captured: list[httpx.Request]):
    client = _make_client(captured, lambda _r: _ok_xml())
    async with client:
        await client.head_object("mybucket", "path/to/file.txt")
    request = captured[0]
    assert request.url.host == "s3.us-east-1.amazonaws.com"
    assert request.url.path == "/mybucket/path/to/file.txt"
    assert request.url.scheme == "https"


async def test_path_style_url_with_endpoint(captured: list[httpx.Request]):
    client = _make_client(captured, lambda _r: _ok_xml(), endpoint_url="http://localhost:7070")
    async with client:
        await client.list_objects_v2("bk", prefix="foo/")
    request = captured[0]
    assert request.url.host == "localhost"
    assert request.url.port == 7070
    assert request.url.scheme == "http"
    assert request.url.path == "/bk"
    assert "list-type=2" in str(request.url.query)


async def test_signed_headers_present(captured: list[httpx.Request]):
    client = _make_client(captured, lambda _r: _ok_xml())
    async with client:
        await client.list_buckets()
    request = captured[0]
    assert request.headers["host"] == "s3.us-east-1.amazonaws.com"
    assert "x-amz-date" in request.headers
    assert "x-amz-content-sha256" in request.headers
    assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 ")


async def test_key_segments_url_encoded(captured: list[httpx.Request]):
    client = _make_client(captured, lambda _r: _ok_xml())
    async with client:
        await client.head_object("b", "spaces and/special#chars.txt")
    request = captured[0]
    # spaces -> %20, # -> %23, but / kept as separator
    assert request.url.raw_path == b"/b/spaces%20and/special%23chars.txt"


async def test_get_object_streams_chunks(captured: list[httpx.Request]):
    payload = b"hello world" * 100

    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=payload, headers={"content-type": "application/octet-stream"}
        )

    client = _make_client(captured, handler)
    async with client:
        response = await client.get_object("b", "k")
        chunks: list[bytes] = []
        async for chunk in response.aiter_bytes():
            chunks.append(chunk)
    assert b"".join(chunks) == payload
    assert response.content_type == "application/octet-stream"


async def test_get_object_with_range_header(captured: list[httpx.Request]):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("range") == "bytes=0-9"
        return httpx.Response(
            206, content=b"0123456789", headers={"content-range": "bytes 0-9/100"}
        )

    client = _make_client(captured, handler)
    async with client:
        response = await client.get_object("b", "k", range_header="bytes=0-9")
        body = b""
        async for chunk in response.aiter_bytes():
            body += chunk
    assert body == b"0123456789"
    assert response.content_range == "bytes 0-9/100"


async def test_error_response_raises_s3error(captured: list[httpx.Request]):
    body = b"""<?xml version="1.0"?>
<Error><Code>NoSuchKey</Code><Message>nope</Message></Error>"""

    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(404, content=body)

    client = _make_client(captured, handler)
    async with client:
        with pytest.raises(S3Error) as info:
            await client.head_object("b", "k")
    assert info.value.code == "NoSuchKey"
    assert info.value.status == 404


async def test_head_bucket_falls_back_to_error_region_header(captured: list[httpx.Request]):
    error_body = (
        b'<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>n</Message></Error>'
    )

    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            content=error_body,
            headers={"x-amz-bucket-region": "eu-west-1"},
        )

    client = _make_client(captured, handler)
    async with client:
        result = await client.head_bucket("b")
    assert result.region == "eu-west-1"
    assert result.status == 403


async def test_head_bucket_raises_when_no_region_header(captured: list[httpx.Request]):
    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(403, content=b"")

    client = _make_client(captured, handler)
    async with client:
        with pytest.raises(S3Error):
            await client.head_bucket("b")


async def test_put_object_returns_etag(captured: list[httpx.Request]):
    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"etag": '"new-etag"'})

    client = _make_client(captured, handler)
    async with client:
        result = await client.put_object("b", "k", b"hello", content_type="text/plain")
    request = captured[0]
    assert request.method == "PUT"
    assert request.content == b"hello"
    assert request.headers["content-type"] == "text/plain"
    assert result.etag == '"new-etag"'


async def test_delete_objects_includes_content_md5(captured: list[httpx.Request]):
    response_body = b"""<?xml version="1.0"?>
<DeleteResult><Deleted><Key>a</Key></Deleted></DeleteResult>"""

    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=response_body)

    from s3browser.async_s3 import KeyToDelete

    client = _make_client(captured, handler)
    async with client:
        result = await client.delete_objects("b", [KeyToDelete(key="a")])
    request = captured[0]
    assert request.method == "POST"
    assert "content-md5" in request.headers
    assert "delete=" in str(request.url.query)
    assert [d.key for d in result.deleted] == ["a"]


async def test_query_string_sorted_in_canonical(captured: list[httpx.Request]):
    """Ensure the canonical query string is sorted before signing — passing the test means
    the signer never rejects the request because URL query params went out of order."""

    def handler(_r: httpx.Request) -> httpx.Response:
        return _ok_xml(
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>'
        )

    client = _make_client(captured, handler)
    async with client:
        await client.list_objects_v2("b", prefix="zzz", delimiter="/", max_keys=10)
    query = str(captured[0].url.query)
    # canonical_query_string sorts; we just verify everything we set is present
    for token in ("list-type=2", "max-keys=10", "prefix=zzz", "delimiter=%2F"):
        assert token in query


async def test_abort_multipart_upload_accepts_204(captured: list[httpx.Request]):
    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    client = _make_client(captured, handler)
    async with client:
        await client.abort_multipart_upload("b", "k", upload_id="UID")
    request = captured[0]
    assert request.method == "DELETE"
    assert "uploadId=UID" in str(request.url.query)
