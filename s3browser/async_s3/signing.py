from __future__ import annotations

import hashlib
import hmac
from datetime import datetime
from functools import reduce
from urllib.parse import quote

_AWS_AUTH_REQUEST = "aws4_request"
_AUTH_ALGORITHM = "AWS4-HMAC-SHA256"
_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"


def encode_uri_path(path: str) -> str:
    return quote(path, safe="/~")


def encode_uri_segment(segment: str) -> str:
    return quote(segment, safe="~")


def canonical_query_string(query: dict[str, str] | list[tuple[str, str]]) -> str:
    items = list(query.items()) if isinstance(query, dict) else list(query)
    encoded = sorted((quote(k, safe="-_.~"), quote(v, safe="-_.~")) for k, v in items)
    return "&".join(f"{k}={v}" for k, v in encoded)


def amz_date(dt: datetime) -> str:
    return dt.strftime("%Y%m%dT%H%M%SZ")


def date_stamp(dt: datetime) -> str:
    return dt.strftime("%Y%m%d")


def _hmac_sha256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


class SigV4Signer:
    def __init__(
        self, *, access_key_id: str, secret_access_key: str, region: str, service: str = "s3"
    ) -> None:
        self.access_key_id = access_key_id
        self.secret_access_key = secret_access_key
        self.region = region
        self.service = service

    def scope(self, dt: datetime) -> str:
        return f"{date_stamp(dt)}/{self.region}/{self.service}/{_AWS_AUTH_REQUEST}"

    def credential(self, dt: datetime) -> str:
        return f"{self.access_key_id}/{self.scope(dt)}"

    def signing_key(self, dt: datetime) -> bytes:
        parts: tuple[bytes | str, ...] = (
            b"AWS4" + self.secret_access_key.encode(),
            date_stamp(dt),
            self.region,
            self.service,
            _AWS_AUTH_REQUEST,
        )

        def step(key: bytes, msg: str | bytes) -> bytes:
            if isinstance(msg, bytes):
                return msg
            return _hmac_sha256(key, msg)

        return reduce(step, parts)  # type: ignore[arg-type]

    def canonical_request(
        self,
        *,
        method: str,
        canonical_uri: str,
        canonical_query: str,
        headers: dict[str, str],
        payload_sha256: str,
    ) -> tuple[str, str]:
        header_keys = sorted(k.lower() for k in headers)
        normalized = {k.lower(): " ".join(headers[k].split()) for k in headers}
        canonical_headers = "".join(f"{k}:{normalized[k]}\n" for k in header_keys)
        signed_headers = ";".join(header_keys)
        canonical = "\n".join(
            (
                method,
                canonical_uri,
                canonical_query,
                canonical_headers,
                signed_headers,
                payload_sha256,
            )
        )
        return canonical, signed_headers

    def string_to_sign(self, dt: datetime, canonical_request: str) -> str:
        return "\n".join(
            (
                _AUTH_ALGORITHM,
                amz_date(dt),
                self.scope(dt),
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            )
        )

    def sign_string(self, dt: datetime, string_to_sign: str) -> str:
        return hmac.new(self.signing_key(dt), string_to_sign.encode(), hashlib.sha256).hexdigest()

    def sign_request(
        self,
        *,
        method: str,
        canonical_uri: str,
        canonical_query: str,
        headers: dict[str, str],
        payload_sha256: str,
        now: datetime,
    ) -> dict[str, str]:
        signed = dict(headers)
        signed.setdefault("x-amz-date", amz_date(now))
        signed.setdefault("x-amz-content-sha256", payload_sha256)
        canonical, signed_headers = self.canonical_request(
            method=method,
            canonical_uri=canonical_uri,
            canonical_query=canonical_query,
            headers=signed,
            payload_sha256=payload_sha256,
        )
        sts = self.string_to_sign(now, canonical)
        signature = self.sign_string(now, sts)
        signed["authorization"] = (
            f"{_AUTH_ALGORITHM} Credential={self.credential(now)},"
            f"SignedHeaders={signed_headers},Signature={signature}"
        )
        return signed

    def presign(
        self,
        *,
        method: str,
        host: str,
        canonical_uri: str,
        extra_query: dict[str, str] | None,
        expires_in: int,
        now: datetime,
        scheme: str = "https",
    ) -> str:
        if expires_in < 1 or expires_in > 604800:
            raise ValueError("expires_in must be between 1 and 604800 seconds")
        query: list[tuple[str, str]] = [
            ("X-Amz-Algorithm", _AUTH_ALGORITHM),
            ("X-Amz-Credential", self.credential(now)),
            ("X-Amz-Date", amz_date(now)),
            ("X-Amz-Expires", str(expires_in)),
            ("X-Amz-SignedHeaders", "host"),
        ]
        if extra_query:
            for key, value in extra_query.items():
                query.append((key, value))
        canonical_query = canonical_query_string(query)
        canonical, signed_headers = self.canonical_request(
            method=method,
            canonical_uri=canonical_uri,
            canonical_query=canonical_query,
            headers={"host": host},
            payload_sha256=_UNSIGNED_PAYLOAD,
        )
        signature = self.sign_string(now, self.string_to_sign(now, canonical))
        signed_query = canonical_query + f"&X-Amz-Signature={signature}"
        del signed_headers  # only used by sign_request
        return f"{scheme}://{host}{canonical_uri}?{signed_query}"
