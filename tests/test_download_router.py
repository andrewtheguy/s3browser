from __future__ import annotations

import asyncio
from typing import Any

from s3browser.routers.download import STREAM_CHUNK_SIZE, _iter_body


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
