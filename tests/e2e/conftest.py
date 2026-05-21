from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
import pytest_asyncio

from s3browser.async_s3 import S3Client


@dataclass
class VersityGW:
    endpoint: str
    access_key: str
    secret_key: str
    root: Path


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_for_listen(host: str, port: int, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    last_error: OSError | None = None
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1.0):
                return
        except OSError as error:
            last_error = error
            time.sleep(0.1)
    raise RuntimeError(f"versitygw did not start on {host}:{port}: {last_error}")


@pytest.fixture(scope="session")
def versitygw(tmp_path_factory: pytest.TempPathFactory) -> Iterator[VersityGW]:
    binary = shutil.which("versitygw")
    if binary is None:
        pytest.skip(
            "versitygw not installed; "
            "run `go install github.com/versity/versitygw@latest` and put $GOPATH/bin on PATH"
        )

    root = tmp_path_factory.mktemp("versitygw-data")
    sidecar = tmp_path_factory.mktemp("versitygw-sidecar")
    port = _pick_free_port()
    env = {
        **os.environ,
        "ROOT_ACCESS_KEY": "testkey",
        "ROOT_SECRET_KEY": "testsecret",
    }
    proc = subprocess.Popen(
        [
            binary,
            "--port",
            f":{port}",
            "posix",
            "--sidecar",
            str(sidecar),
            str(root),
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        _wait_for_listen("127.0.0.1", port)
    except Exception:
        proc.terminate()
        stdout, stderr = proc.communicate(timeout=5)
        raise RuntimeError(
            "versitygw failed to start:\n"
            f"stdout: {stdout.decode(errors='replace')}\n"
            f"stderr: {stderr.decode(errors='replace')}"
        ) from None
    try:
        yield VersityGW(
            endpoint=f"http://127.0.0.1:{port}",
            access_key="testkey",
            secret_key="testsecret",
            root=root,
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


@pytest_asyncio.fixture
async def s3_client(versitygw: VersityGW) -> AsyncIterator[S3Client]:
    async with S3Client(
        access_key_id=versitygw.access_key,
        secret_access_key=versitygw.secret_key,
        region="us-east-1",
        endpoint_url=versitygw.endpoint,
    ) as client:
        yield client


@pytest_asyncio.fixture
async def bucket(versitygw: VersityGW, s3_client: S3Client) -> AsyncIterator[str]:
    """Create a fresh bucket per test (PUT bucket via VersityGW) and clean it up after."""
    name = f"test-{uuid.uuid4().hex[:12]}"
    # VersityGW's posix backend creates buckets via S3 PUT or by mkdir on the root.
    # PUT bucket is the portable path so we use it.
    await s3_client._request(method="PUT", bucket=name, ok_statuses=(200,))
    try:
        yield name
    finally:
        # Best-effort cleanup: delete all keys then drop the bucket.
        try:
            listing = await s3_client.list_objects_v2(name)
            from s3browser.async_s3 import KeyToDelete

            if listing.contents:
                await s3_client.delete_objects(
                    name, [KeyToDelete(key=item.key) for item in listing.contents]
                )
            await s3_client._request(method="DELETE", bucket=name, ok_statuses=(204,))
        except Exception:
            pass
