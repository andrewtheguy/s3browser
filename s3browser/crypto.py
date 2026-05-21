import base64
import hashlib
import hmac
import secrets

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from s3browser.config import get_encryption_key_source

IV_LENGTH = 12
AUTH_TAG_LENGTH = 16
SALT_LENGTH = 32

_salt: bytes | None = None
_encryption_key: bytes | None = None


def set_salt(salt: bytes) -> None:
    global _encryption_key, _salt
    if len(salt) != SALT_LENGTH:
        raise RuntimeError(f"Salt must be exactly {SALT_LENGTH} bytes")
    _salt = salt
    _encryption_key = None


def generate_salt() -> bytes:
    return secrets.token_bytes(SALT_LENGTH)


def _get_encryption_key() -> bytes:
    global _encryption_key
    if _encryption_key is not None:
        return _encryption_key
    if _salt is None:
        raise RuntimeError("Encryption salt not initialized")
    _encryption_key = hashlib.scrypt(
        get_encryption_key_source().encode("utf-8"),
        salt=_salt,
        n=16384,
        r=8,
        p=1,
        dklen=32,
    )
    return _encryption_key


def encrypt(plaintext: str) -> str:
    key = _get_encryption_key()
    iv = secrets.token_bytes(IV_LENGTH)
    encryptor = Cipher(algorithms.AES(key), modes.GCM(iv)).encryptor()
    encrypted = encryptor.update(plaintext.encode("utf-8")) + encryptor.finalize()
    return base64.b64encode(iv + encryptor.tag + encrypted).decode("ascii")


def decrypt(ciphertext: str) -> str:
    combined = base64.b64decode(ciphertext)
    if len(combined) < IV_LENGTH + AUTH_TAG_LENGTH:
        raise RuntimeError("Invalid ciphertext: too short")
    iv = combined[:IV_LENGTH]
    tag = combined[IV_LENGTH : IV_LENGTH + AUTH_TAG_LENGTH]
    encrypted = combined[IV_LENGTH + AUTH_TAG_LENGTH :]
    decryptor = Cipher(algorithms.AES(_get_encryption_key()), modes.GCM(iv, tag)).decryptor()
    decrypted = decryptor.update(encrypted) + decryptor.finalize()
    return decrypted.decode("utf-8")


def validate_encryption_key() -> None:
    _get_encryption_key()


def timing_safe_compare(left: str, right: str) -> bool:
    return secrets.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def hmac_sha256_base64url(data: str, key: str) -> str:
    return base64url(hmac.new(key.encode("utf-8"), data.encode("utf-8"), hashlib.sha256).digest())
