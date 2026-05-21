import json
import time
from functools import lru_cache
from hashlib import scrypt

from s3browser.config import get_login_password
from s3browser.crypto import base64url, base64url_decode, hmac_sha256_base64url, timing_safe_compare

AUTH_COOKIE_NAME = "s3browser_auth_token"
TOKEN_EXPIRATION_SECONDS = 4 * 60 * 60
CLOCK_SKEW_SECONDS = 30
JWT_ALGORITHM = "HS256"
JWT_TYPE = "JWT"
JWT_HEADER_B64 = base64url(
    json.dumps({"alg": JWT_ALGORITHM, "typ": JWT_TYPE}, separators=(",", ":")).encode()
)


@lru_cache
def _signing_key() -> str:
    derived = scrypt(
        get_login_password().encode("utf-8"),
        salt=b"s3browser-auth-token-v1",
        n=16384,
        r=8,
        p=1,
        dklen=32,
    )
    return base64url(derived)


def create_auth_token() -> str:
    now = int(time.time())
    payload = {"iat": now, "exp": now + TOKEN_EXPIRATION_SECONDS}
    payload_b64 = base64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{JWT_HEADER_B64}.{payload_b64}"
    signature = hmac_sha256_base64url(signing_input, _signing_key())
    return f"{signing_input}.{signature}"


def verify_auth_token(token: str | None) -> bool:
    if not token:
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    header_b64, payload_b64, signature = parts
    try:
        header = json.loads(base64url_decode(header_b64).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return False
    if header.get("alg") != JWT_ALGORITHM or header.get("typ") != JWT_TYPE:
        return False
    signing_input = f"{header_b64}.{payload_b64}"
    expected = hmac_sha256_base64url(signing_input, _signing_key())
    if not timing_safe_compare(signature, expected):
        return False
    try:
        payload = json.loads(base64url_decode(payload_b64).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return False
    now = int(time.time())
    exp = payload.get("exp")
    iat = payload.get("iat")
    return (
        isinstance(exp, int)
        and exp > now
        and isinstance(iat, int)
        and iat <= now + CLOCK_SKEW_SECONDS
    )
