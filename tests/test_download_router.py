from __future__ import annotations

import asyncio
from io import BytesIO
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlencode
from zipfile import ZipFile

from starlette.requests import Request
from starlette.responses import StreamingResponse

from s3browser.routers import download
from s3browser.routers.download import (
    STREAM_CHUNK_SIZE,
    BatchZipTicketRequest,
    ZipEntry,
    _iter_body,
)


class FakeStreamingBody:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.read_sizes: list[int] = []
        self.release_called = False
        self.wait_for_close_called = False

    async def __aenter__(self) -> object:
        raise AssertionError("_iter_body must read from StreamingBody directly")

    async def __aexit__(self, *_args: Any) -> None:
        raise AssertionError("_iter_body must not use StreamingBody as a context manager")

    async def read(self, size: int) -> bytes:
        self.read_sizes.append(size)
        if not self._chunks:
            return b""
        return self._chunks.pop(0)

    def release(self) -> None:
        self.release_called = True

    async def wait_for_close(self) -> None:
        self.wait_for_close_called = True


def test_iter_body_reads_chunks_directly_and_releases_body() -> None:
    async def run() -> FakeStreamingBody:
        body = FakeStreamingBody([b"hello", b"world"])
        chunks = [chunk async for chunk in _iter_body(body)]

        assert chunks == [b"hello", b"world"]
        assert body.read_sizes == [STREAM_CHUNK_SIZE, STREAM_CHUNK_SIZE, STREAM_CHUNK_SIZE]
        assert body.release_called
        assert body.wait_for_close_called
        return body

    asyncio.run(run())


def test_iter_body_releases_body_when_stream_is_closed_early() -> None:
    async def run() -> FakeStreamingBody:
        body = FakeStreamingBody([b"hello", b"world"])
        stream = _iter_body(body)

        first_chunk = await anext(stream)
        assert first_chunk == b"hello"

        await stream.aclose()
        assert body.release_called
        assert body.wait_for_close_called
        return body

    asyncio.run(run())


class FakeS3Client:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.body: FakeStreamingBody | None = None

    async def get_object(self, **params: object) -> dict[str, object]:
        self.calls.append(params)
        self.body = FakeStreamingBody([b"hello ", b"streaming zip"])
        return {"Body": self.body}


class FlakyStreamingBody:
    """Body that yields some chunks, then raises to simulate a dropped connection."""

    def __init__(self, data: bytes, fail_after: int | None) -> None:
        self._data = data
        self._reads_left = fail_after
        self.release_called = False

    async def read(self, size: int) -> bytes:
        if self._reads_left is not None and self._reads_left == 0:
            raise ConnectionResetError("connection dropped mid-body")
        if self._reads_left is not None:
            self._reads_left -= 1
        chunk, self._data = self._data[:size], self._data[size:]
        return chunk

    def release(self) -> None:
        self.release_called = True


class ResumableS3Client:
    """Returns a failing body first, then serves ranged resumes from full content."""

    def __init__(self, content: bytes, fail_after_reads: list[int | None]) -> None:
        self._content = content
        self._fail_after_reads = fail_after_reads
        self.calls: list[dict[str, object]] = []
        self.bodies: list[FlakyStreamingBody] = []

    async def get_object(self, **params: object) -> dict[str, object]:
        self.calls.append(params)
        offset = 0
        range_header = params.get("Range")
        if isinstance(range_header, str):
            offset = int(range_header.removeprefix("bytes=").removesuffix("-"))
        fail_after = self._fail_after_reads.pop(0) if self._fail_after_reads else None
        body = FlakyStreamingBody(self._content[offset:], fail_after)
        self.bodies.append(body)
        return {"Body": body, "ETag": '"abc123"'}


def _batch_zip_chunks(client: object, entries: list[ZipEntry]) -> list[bytes]:
    async def run() -> list[bytes]:
        download._ZIP_TICKETS.clear()
        context = SimpleNamespace(
            connection_id=7,
            credentials=SimpleNamespace(bucket="example-bucket"),
            client=client,
        )
        ticket_result = await download.create_batch_zip_ticket(
            BatchZipTicketRequest(entries=entries, archiveName="folder.zip"),
            context=context,  # type: ignore[arg-type]
        )
        request = Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/api/download/7/example-bucket/batch-zip",
                "query_string": urlencode({"ticket": ticket_result["ticket"]}).encode(),
                "headers": [],
            }
        )
        response = await download.download_batch_zip(
            request,
            context=context,  # type: ignore[arg-type]
        )
        assert isinstance(response, StreamingResponse)
        chunks = [chunk async for chunk in response.body_iterator]
        download._ZIP_TICKETS.clear()
        return chunks

    return asyncio.run(run())


def test_batch_zip_resumes_entry_with_ranged_get_after_mid_body_failure() -> None:
    content = b"0123456789" * 20000  # multiple STREAM_CHUNK_SIZE reads
    client = ResumableS3Client(content, fail_after_reads=[1])
    chunks = _batch_zip_chunks(client, [ZipEntry(key="folder/file.txt", name="file.txt")])

    assert len(client.calls) == 2
    resume_call = client.calls[1]
    assert resume_call["Range"] == f"bytes={STREAM_CHUNK_SIZE}-"
    assert resume_call["IfMatch"] == '"abc123"'
    assert all(body.release_called for body in client.bodies)

    with ZipFile(BytesIO(b"".join(chunks))) as zip_file:
        assert zip_file.namelist() == ["file.txt"]
        assert zip_file.read("file.txt") == content


def test_batch_zip_records_truncated_entry_when_resumes_are_exhausted() -> None:
    content = b"0123456789" * 20000
    # The initial body fails after one read; every resume fails immediately.
    client = ResumableS3Client(content, fail_after_reads=[1] + [0] * download.MAX_MEMBER_RESUMES)
    chunks = _batch_zip_chunks(client, [ZipEntry(key="folder/file.txt", name="file.txt")])

    assert len(client.calls) == download.MAX_MEMBER_RESUMES + 1

    with ZipFile(BytesIO(b"".join(chunks))) as zip_file:
        assert zip_file.namelist() == ["file.txt", download.ERROR_MANIFEST_NAME]
        assert zip_file.read("file.txt") == content[:STREAM_CHUNK_SIZE]
        manifest = zip_file.read(download.ERROR_MANIFEST_NAME).decode()
        assert "file.txt: truncated at" in manifest


def test_batch_zip_response_streams_archive_from_s3() -> None:
    async def run() -> None:
        download._ZIP_TICKETS.clear()
        client = FakeS3Client()
        context = SimpleNamespace(
            connection_id=7,
            credentials=SimpleNamespace(bucket="example-bucket"),
            client=client,
        )
        ticket_result = await download.create_batch_zip_ticket(
            BatchZipTicketRequest(
                entries=[ZipEntry(key="folder/file.txt", name="file.txt")],
                archiveName="folder.zip",
            ),
            context=context,  # type: ignore[arg-type]
        )
        query_string = urlencode({"ticket": ticket_result["ticket"]}).encode()
        request = Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/api/download/7/example-bucket/batch-zip",
                "query_string": query_string,
                "headers": [],
            }
        )

        response = await download.download_batch_zip(
            request,
            context=context,  # type: ignore[arg-type]
        )

        assert isinstance(response, StreamingResponse)
        assert response.headers["content-type"] == "application/zip"
        assert "folder.zip" in response.headers["content-disposition"]
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-accel-buffering"] == "no"
        assert "content-length" not in response.headers
        # S3 is untouched until the response iterator is consumed.
        assert client.calls == []

        chunks = [chunk async for chunk in response.body_iterator]
        assert len(chunks) > 1
        assert client.calls == [{"Bucket": "example-bucket", "Key": "folder/file.txt"}]
        assert client.body is not None
        assert client.body.read_sizes == [
            STREAM_CHUNK_SIZE,
            STREAM_CHUNK_SIZE,
            STREAM_CHUNK_SIZE,
        ]
        assert client.body.release_called
        assert client.body.wait_for_close_called

        archive = BytesIO(b"".join(chunks))
        with ZipFile(archive) as zip_file:
            assert zip_file.namelist() == ["file.txt"]
            assert zip_file.read("file.txt") == b"hello streaming zip"

        download._ZIP_TICKETS.clear()

    asyncio.run(run())
