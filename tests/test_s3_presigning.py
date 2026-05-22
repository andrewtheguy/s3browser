from __future__ import annotations

import asyncio
from urllib.parse import parse_qs, urlparse

from s3browser.s3 import S3Credentials, _client_config, create_s3_client


def _presigned_get_url(endpoint: str | None, key: str = "shows/test.m4a") -> str:
    async def run() -> str:
        credentials = S3Credentials(
            access_key_id="AKIAEXAMPLE",
            secret_access_key="secret",
            region="us-east-1",
            endpoint=endpoint,
        )
        async with create_s3_client(credentials) as client:
            return await client.generate_presigned_url(
                "get_object",
                Params={"Bucket": "radio-show", "Key": key},
                ExpiresIn=3600,
            )

    return asyncio.run(run())


def _assert_sigv4_query(url: str) -> dict[str, list[str]]:
    query = parse_qs(urlparse(url).query)

    assert query["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert "X-Amz-Signature" in query
    assert "AWSAccessKeyId" not in query
    assert "Signature" not in query
    assert "Expires" not in query
    return query


def test_client_config_forces_path_style_for_custom_endpoints() -> None:
    config = _client_config("https://objstore.local.168234.xyz")

    assert config.signature_version == "s3v4"
    assert config.s3 == {"addressing_style": "path"}


def test_client_config_for_aws_still_forces_sigv4() -> None:
    config = _client_config(None)

    assert config.signature_version == "s3v4"
    assert config.s3 is None


def test_custom_endpoint_presigned_url_uses_sigv4_and_path_style() -> None:
    url = _presigned_get_url("https://objstore.local.168234.xyz")
    parsed = urlparse(url)

    assert parsed.netloc == "objstore.local.168234.xyz"
    assert parsed.path == "/radio-show/shows/test.m4a"
    _assert_sigv4_query(url)


def test_custom_endpoint_presigned_url_keeps_unicode_key_sigv4() -> None:
    url = _presigned_get_url(
        "https://objstore.local.168234.xyz",
        "shows/rthk-radio2/2026/05/21/20260521_2200_0000_她．他．它.m4a",
    )
    parsed = urlparse(url)

    assert parsed.netloc == "objstore.local.168234.xyz"
    assert parsed.path == (
        "/radio-show/shows/rthk-radio2/2026/05/21/"
        "20260521_2200_0000_%E5%A5%B9%EF%BC%8E%E4%BB%96%EF%BC%8E%E5%AE%83.m4a"
    )
    _assert_sigv4_query(url)


def test_aws_presigned_url_uses_sigv4() -> None:
    url = _presigned_get_url(None)

    _assert_sigv4_query(url)
