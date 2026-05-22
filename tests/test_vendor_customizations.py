from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock

import pytest
from botocore.exceptions import ClientError

import s3browser.s3 as s3_module
from s3browser.routers.bucket import (
    _is_encryption_not_supported,
    _is_lifecycle_not_configured,
)
from s3browser.routers.objects import _is_versioning_not_supported
from s3browser.s3 import error_code, http_status_code


def _client_error(code: str | None, status: int | None, message: str = "boom") -> ClientError:
    error_response: dict[str, Any] = {"Error": {"Message": message}}
    if code is not None:
        error_response["Error"]["Code"] = code
    if status is not None:
        error_response["ResponseMetadata"] = {"HTTPStatusCode": status}
    return ClientError(error_response=error_response, operation_name="TestOp")


def test_http_status_code_extracts_from_client_error() -> None:
    assert http_status_code(_client_error("NotImplemented", 501)) == 501
    assert http_status_code(_client_error("AccessDenied", 403)) == 403


def test_http_status_code_returns_none_for_unknown_errors() -> None:
    assert http_status_code(RuntimeError("not a ClientError")) is None
    assert http_status_code(_client_error("NoStatus", None)) is None


def test_error_code_extracts_from_client_error() -> None:
    assert error_code(_client_error("NotImplemented", 501)) == "NotImplemented"
    assert error_code(_client_error(None, 500)) == ""


def test_encryption_not_supported_matches_501_status() -> None:
    assert _is_encryption_not_supported(_client_error(None, 501, "generic 501")) is True


@pytest.mark.parametrize(
    "code",
    [
        "NotImplemented",
        "NotImplementedException",
        "NotImplementedError",
        "UnsupportedOperation",
    ],
)
def test_encryption_not_supported_matches_known_codes(code: str) -> None:
    assert _is_encryption_not_supported(_client_error(code, 400)) is True


def test_encryption_not_supported_matches_unimplemented_substring() -> None:
    assert _is_encryption_not_supported(RuntimeError("This op is unimplemented")) is True


def test_encryption_not_supported_returns_false_for_unrelated_errors() -> None:
    assert _is_encryption_not_supported(_client_error("AccessDenied", 403)) is False
    assert _is_encryption_not_supported(RuntimeError("permission denied")) is False


def test_lifecycle_not_configured_matches_404_no_such_lifecycle_code() -> None:
    error = _client_error("NoSuchLifecycleConfiguration", 404)
    assert _is_lifecycle_not_configured(error) is True


def test_lifecycle_not_configured_matches_404_not_found_code() -> None:
    error = _client_error("NotFound", 404)
    assert _is_lifecycle_not_configured(error) is True


def test_lifecycle_not_configured_matches_404_with_lifecycle_in_message() -> None:
    error_response: dict[str, Any] = {
        "Error": {"Message": "Bucket has no lifecycle policy attached"},
        "ResponseMetadata": {"HTTPStatusCode": 404},
    }
    error = ClientError(error_response=error_response, operation_name="GetBucketLifecycle")
    assert _is_lifecycle_not_configured(error) is True


def test_lifecycle_not_configured_returns_false_for_404_without_code_or_message() -> None:
    error_response: dict[str, Any] = {
        "Error": {"Message": "not found"},
        "ResponseMetadata": {"HTTPStatusCode": 404},
    }
    error = ClientError(error_response=error_response, operation_name="GetBucketLifecycle")
    assert _is_lifecycle_not_configured(error) is False


def test_lifecycle_not_configured_returns_false_for_access_denied() -> None:
    assert _is_lifecycle_not_configured(_client_error("AccessDenied", 403)) is False


def test_versioning_not_supported_matches_explicit_not_implemented_code() -> None:
    assert _is_versioning_not_supported(_client_error("NotImplemented", 400)) is True


def test_versioning_not_supported_matches_bare_501_status() -> None:
    assert _is_versioning_not_supported(_client_error("InternalError", 501)) is True


def test_versioning_not_supported_matches_substring_fallback() -> None:
    assert _is_versioning_not_supported(RuntimeError("NotImplemented operation")) is True


@pytest.mark.parametrize(
    "message",
    [
        "NotImplemented operation",
        "notimplemented",
        "NOTIMPLEMENTED",
        "Not Implemented",
        "not implemented",
        "NOT IMPLEMENTED",
    ],
)
def test_versioning_not_supported_substring_match_is_case_insensitive(message: str) -> None:
    assert _is_versioning_not_supported(RuntimeError(message)) is True


def test_versioning_not_supported_returns_false_for_access_denied() -> None:
    assert _is_versioning_not_supported(_client_error("AccessDenied", 403)) is False


def test_module_session_forces_regional_sts_endpoint() -> None:
    """Regression: the module session must set sts_regional_endpoints='regional' so that
    a user with AWS_STS_REGIONAL_ENDPOINTS=legacy in their environment doesn't get the
    global sts.amazonaws.com endpoint that only works in us-east-1.
    """
    assert s3_module._session.get_config_variable("sts_regional_endpoints") == "regional"


def test_sts_client_resolves_regional_endpoint_for_non_us_east_1() -> None:
    """End-to-end: an STS client created via the module session in eu-west-1 should
    resolve to the regional endpoint, not the global one."""

    async def resolve() -> str:
        async with s3_module._create_aio_client(
            "sts",
            region_name="eu-west-1",
            aws_access_key_id="AKIAEXAMPLE",
            aws_secret_access_key="secret",
        ) as client:
            return str(client.meta.endpoint_url)

    endpoint = asyncio.run(resolve())
    assert "eu-west-1" in endpoint
    assert endpoint != "https://sts.amazonaws.com"


def test_validate_credentials_only_uses_module_session_for_sts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: validate_credentials_only(no endpoint) must create the STS client via
    the module session (which has sts_regional_endpoints forced to 'regional'), not via
    a one-off session that would re-read environment overrides.
    """
    captured: dict[str, Any] = {}

    @asynccontextmanager
    async def fake_create_aio_client(service: str, **kwargs: Any) -> AsyncIterator[Any]:
        captured.setdefault("calls", []).append({"service": service, "kwargs": kwargs})
        client = AsyncMock()
        client.get_caller_identity = AsyncMock(return_value={})
        yield client

    monkeypatch.setattr(s3_module, "_create_aio_client", fake_create_aio_client)

    result = asyncio.run(
        s3_module.validate_credentials_only("AKIAEXAMPLE", "secret", "eu-west-1", None)
    )

    assert result == {"valid": True}
    sts_calls = [c for c in captured["calls"] if c["service"] == "sts"]
    assert len(sts_calls) == 1
    assert sts_calls[0]["kwargs"]["region_name"] == "eu-west-1"


def test_detect_bucket_region_deduped_coalesces_concurrent_callers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: when multiple endpoints (object listing, bucket info, versioning)
    fire concurrently before the region cache is populated, only one GetBucketLocation
    call should hit the network — the rest should share the in-flight future.
    """
    call_count = 0

    async def fake_get_bucket_region(*_args: Any, **_kwargs: Any) -> str:
        nonlocal call_count
        call_count += 1
        await asyncio.sleep(0.02)
        return "eu-west-1"

    monkeypatch.setattr(s3_module, "get_bucket_region", fake_get_bucket_region)
    s3_module._region_detection_in_flight.clear()

    async def run() -> list[str]:
        return await asyncio.gather(
            *[
                s3_module._detect_bucket_region_deduped("conn:bucket", "ak", "sk", "bucket", None)
                for _ in range(5)
            ]
        )

    results = asyncio.run(run())

    assert results == ["eu-west-1"] * 5
    assert call_count == 1
    assert "conn:bucket" not in s3_module._region_detection_in_flight


def test_detect_bucket_region_deduped_propagates_errors_to_waiters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_get_bucket_region(*_args: Any, **_kwargs: Any) -> str:
        await asyncio.sleep(0.01)
        raise RuntimeError("region detection failed")

    monkeypatch.setattr(s3_module, "get_bucket_region", fake_get_bucket_region)
    s3_module._region_detection_in_flight.clear()

    async def run() -> list[BaseException | str]:
        return await asyncio.gather(
            *[
                s3_module._detect_bucket_region_deduped("c:b", "ak", "sk", "b", None)
                for _ in range(3)
            ],
            return_exceptions=True,
        )

    results = asyncio.run(run())

    assert len(results) == 3
    assert all(isinstance(r, RuntimeError) for r in results)
    assert "c:b" not in s3_module._region_detection_in_flight
