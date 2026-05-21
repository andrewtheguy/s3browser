"""SigV4 known-answer tests against AWS's published examples.

Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from s3browser.async_s3.signing import (
    SigV4Signer,
    amz_date,
    canonical_query_string,
    encode_uri_segment,
)

AWS_EXAMPLE_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE"
AWS_EXAMPLE_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
AWS_EXAMPLE_REGION = "us-east-1"
AWS_EXAMPLE_DATE = datetime(2013, 5, 24, 0, 0, 0, tzinfo=UTC)


def _signer() -> SigV4Signer:
    return SigV4Signer(
        access_key_id=AWS_EXAMPLE_ACCESS_KEY,
        secret_access_key=AWS_EXAMPLE_SECRET_KEY,
        region=AWS_EXAMPLE_REGION,
    )


def test_get_object_with_range_known_answer():
    """AWS docs: GET https://examplebucket.s3.amazonaws.com/test.txt with Range header."""
    signer = _signer()
    payload_sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    headers = {
        "host": "examplebucket.s3.amazonaws.com",
        "range": "bytes=0-9",
        "x-amz-date": amz_date(AWS_EXAMPLE_DATE),
        "x-amz-content-sha256": payload_sha256,
    }
    signed = signer.sign_request(
        method="GET",
        canonical_uri="/test.txt",
        canonical_query="",
        headers=headers,
        payload_sha256=payload_sha256,
        now=AWS_EXAMPLE_DATE,
    )
    expected_signature = "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    assert f"Signature={expected_signature}" in signed["authorization"]
    assert "AWS4-HMAC-SHA256" in signed["authorization"]
    credential = (
        f"Credential={AWS_EXAMPLE_ACCESS_KEY}/20130524/{AWS_EXAMPLE_REGION}/s3/aws4_request"
    )
    assert credential in signed["authorization"]
    assert "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date" in signed["authorization"]


def test_put_object_known_answer():
    """AWS docs: PUT https://examplebucket.s3.amazonaws.com/test%24file.text with body."""
    signer = _signer()
    body = b"Welcome to Amazon S3."
    import hashlib

    payload_sha256 = hashlib.sha256(body).hexdigest()
    headers = {
        "host": "examplebucket.s3.amazonaws.com",
        "date": "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-date": amz_date(AWS_EXAMPLE_DATE),
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": payload_sha256,
    }
    signed = signer.sign_request(
        method="PUT",
        canonical_uri="/test%24file.text",
        canonical_query="",
        headers=headers,
        payload_sha256=payload_sha256,
        now=AWS_EXAMPLE_DATE,
    )
    expected_signature = "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
    assert f"Signature={expected_signature}" in signed["authorization"]


def test_list_bucket_with_query_known_answer():
    """AWS docs: GET ?lifecycle on examplebucket."""
    signer = _signer()
    payload_sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    headers = {
        "host": "examplebucket.s3.amazonaws.com",
        "x-amz-date": amz_date(AWS_EXAMPLE_DATE),
        "x-amz-content-sha256": payload_sha256,
    }
    signed = signer.sign_request(
        method="GET",
        canonical_uri="/",
        canonical_query="lifecycle=",
        headers=headers,
        payload_sha256=payload_sha256,
        now=AWS_EXAMPLE_DATE,
    )
    expected_signature = "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
    assert f"Signature={expected_signature}" in signed["authorization"]


def test_canonical_query_string_sorts_and_encodes():
    query = canonical_query_string({"foo": "bar baz", "Z": "1", "a": "2"})
    assert query == "Z=1&a=2&foo=bar%20baz"


def test_canonical_query_string_accepts_pairs():
    query = canonical_query_string([("a", "1"), ("a", "2")])
    assert query == "a=1&a=2"


def test_encode_uri_segment_preserves_safe_chars():
    assert encode_uri_segment("hello world") == "hello%20world"
    assert encode_uri_segment("foo/bar") == "foo%2Fbar"
    assert encode_uri_segment("file~name") == "file~name"


def test_signer_credential_includes_scope():
    signer = _signer()
    assert (
        signer.credential(AWS_EXAMPLE_DATE)
        == f"{AWS_EXAMPLE_ACCESS_KEY}/20130524/us-east-1/s3/aws4_request"
    )


def test_presign_includes_required_params():
    signer = _signer()
    url = signer.presign(
        method="GET",
        host="examplebucket.s3.amazonaws.com",
        canonical_uri="/test.txt",
        extra_query=None,
        expires_in=86400,
        now=AWS_EXAMPLE_DATE,
    )
    assert url.startswith("https://examplebucket.s3.amazonaws.com/test.txt?")
    for param in (
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        "X-Amz-Credential=",
        "X-Amz-Date=20130524T000000Z",
        "X-Amz-Expires=86400",
        "X-Amz-SignedHeaders=host",
        "X-Amz-Signature=",
    ):
        assert param in url


def test_presign_get_object_known_answer():
    """AWS docs example: presigned GET on test.txt for 24h."""
    signer = _signer()
    url = signer.presign(
        method="GET",
        host="examplebucket.s3.amazonaws.com",
        canonical_uri="/test.txt",
        extra_query=None,
        expires_in=86400,
        now=AWS_EXAMPLE_DATE,
    )
    expected_signature = "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    assert f"X-Amz-Signature={expected_signature}" in url


def test_presign_rejects_invalid_expiry():
    signer = _signer()
    for bad in (0, -1, 604801):
        with pytest.raises(ValueError):
            signer.presign(
                method="GET",
                host="examplebucket.s3.amazonaws.com",
                canonical_uri="/x",
                extra_query=None,
                expires_in=bad,
                now=AWS_EXAMPLE_DATE,
            )


def test_presign_appends_extra_query_to_canonical():
    signer = _signer()
    url = signer.presign(
        method="GET",
        host="examplebucket.s3.amazonaws.com",
        canonical_uri="/test.txt",
        extra_query={"response-content-disposition": "attachment; filename=x"},
        expires_in=900,
        now=AWS_EXAMPLE_DATE,
    )
    assert "response-content-disposition=attachment" in url
