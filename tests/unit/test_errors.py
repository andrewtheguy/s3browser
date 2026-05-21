from __future__ import annotations

from s3browser.async_s3.errors import S3Error, parse_error_response


def test_parses_s3_error_xml():
    body = b"""<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Key>missing.txt</Key>
  <RequestId>4442587FB7D0A2F9</RequestId>
  <Resource>/bucket/missing.txt</Resource>
</Error>"""
    err = parse_error_response(404, body)
    assert err.code == "NoSuchKey"
    assert err.message == "The specified key does not exist."
    assert err.status == 404
    assert err.request_id == "4442587FB7D0A2F9"
    assert err.resource == "/bucket/missing.txt"
    assert str(err) == "NoSuchKey: The specified key does not exist."


def test_status_only_fallback_404():
    err = parse_error_response(404, b"")
    assert err.code == "NotFound"
    assert err.status == 404


def test_status_only_fallback_403():
    err = parse_error_response(403, b"")
    assert err.code == "AccessDenied"


def test_status_only_fallback_unknown():
    err = parse_error_response(599, b"")
    assert err.code == "Error"
    assert err.message == "HTTP 599"


def test_plain_text_body_used_as_message():
    err = parse_error_response(500, b"upstream connection reset")
    assert err.code == "Error"
    assert err.message == "upstream connection reset"


def test_headers_are_preserved():
    err = parse_error_response(
        403,
        b"",
        headers={"x-amz-bucket-region": "eu-west-1", "x-amz-request-id": "abc"},
    )
    assert err.headers["x-amz-bucket-region"] == "eu-west-1"
    assert err.headers["x-amz-request-id"] == "abc"


def test_malformed_xml_falls_back_to_status_code():
    err = parse_error_response(500, b"<Error><Code>broken")
    assert err.code == "Error"
    assert err.status == 500


def test_s3error_is_exception():
    err = S3Error(code="AccessDenied", message="nope", status=403)
    assert isinstance(err, Exception)
