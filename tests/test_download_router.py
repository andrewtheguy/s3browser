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
