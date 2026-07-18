import os
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

from s3browser.paths import CONFIG_PATH, ENCRYPTION_KEY_PATH, LOGIN_PASSWORD_PATH

load_dotenv()

SEARCH_WHITELIST_ENV_VAR = "S3BROWSER_SEARCH_WHITELIST_HOSTS"
DEFAULT_PRESIGNED_URL_TTLS = "1h,1d"
MAX_TTL_SECONDS = 7 * 24 * 60 * 60

_ALLOWED_CONFIG_KEYS = {
    "S3BROWSER_BIND",
    "S3BROWSER_LOGIN_PASSWORD",
    "S3BROWSER_PRESIGNED_URL_TTLS",
    SEARCH_WHITELIST_ENV_VAR,
}


@dataclass(frozen=True)
class PresignedUrlTtlOption:
    ttl: int
    shortLabel: str
    longLabel: str


def load_config_file() -> None:
    if not CONFIG_PATH.exists():
        return
    try:
        parsed = tomllib.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as error:
        raise RuntimeError(f"Failed to parse {CONFIG_PATH}: {error}") from error
    for key, value in parsed.items():
        if key not in _ALLOWED_CONFIG_KEYS:
            print(f'config.toml: ignoring unknown key "{key}"')
            continue
        if key in os.environ:
            continue
        if not isinstance(value, str):
            raise RuntimeError(f'config.toml: key "{key}" must be a string')
        os.environ[key] = value


def _read_secret_file(path: Path, minimum_length: int) -> str | None:
    if not path.exists():
        return None
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        print(f"Warning: Failed to read {path}: {error}")
        return None
    if len(value) >= minimum_length:
        return value
    print(f"Warning: {path} exists but contains less than {minimum_length} characters")
    return None


@lru_cache
def get_login_password() -> str:
    password = os.environ.get("S3BROWSER_LOGIN_PASSWORD")
    if not password:
        password = _read_secret_file(LOGIN_PASSWORD_PATH, 16)
    if not password or len(password) < 16:
        raise RuntimeError(
            "Login password not configured. Please either:\n"
            "  1. Set S3BROWSER_LOGIN_PASSWORD environment variable (16+ characters), or\n"
            f"  2. Create {LOGIN_PASSWORD_PATH} with a 16+ character password"
        )
    return password


@lru_cache
def get_encryption_key_source() -> str:
    key = os.environ.get("S3BROWSER_ENCRYPTION_KEY")
    if not key or len(key) < 32:
        key = _read_secret_file(ENCRYPTION_KEY_PATH, 32)
    if not key or len(key) < 32:
        raise RuntimeError(
            "Encryption key not configured. Please either:\n"
            "  1. Set S3BROWSER_ENCRYPTION_KEY environment variable (32+ characters), or\n"
            f"  2. Create {ENCRYPTION_KEY_PATH} with a 32+ character key\n\n"
            "Generate a key with: openssl rand -hex 32"
        )
    return key


def validate_login_password() -> None:
    get_login_password()


def validate_encryption_key_source() -> None:
    get_encryption_key_source()


def _format_ttl(value: int, unit: str) -> str:
    names = {"h": "hour", "d": "day", "w": "week"}
    name = names[unit]
    suffix = "" if value == 1 else "s"
    return f"{value} {name}{suffix}"


def _parse_ttl_entry(entry: str) -> PresignedUrlTtlOption | None:
    trimmed = entry.strip()
    if not trimmed:
        return None
    if len(trimmed) < 2 or not trimmed[:-1].isdigit() or trimmed[-1] not in {"h", "d", "w"}:
        print(f'presignedUrls: ignoring invalid TTL entry "{trimmed}"')
        return None
    value = int(trimmed[:-1])
    unit = trimmed[-1]
    if value <= 0:
        print(f'presignedUrls: ignoring invalid TTL entry "{trimmed}"')
        return None
    seconds_per_unit = {"h": 60 * 60, "d": 60 * 60 * 24, "w": 60 * 60 * 24 * 7}
    ttl = value * seconds_per_unit[unit]
    if ttl > MAX_TTL_SECONDS:
        print(f'presignedUrls: ignoring TTL "{trimmed}" exceeds AWS SigV4 maximum of 7 days')
        return None
    return PresignedUrlTtlOption(ttl=ttl, shortLabel=trimmed, longLabel=_format_ttl(value, unit))


def _parse_raw_ttls(source: str) -> tuple[list[PresignedUrlTtlOption], list[str]]:
    options: list[PresignedUrlTtlOption] = []
    seen: set[str] = set()
    duplicates: list[str] = []
    for entry in source.split(","):
        option = _parse_ttl_entry(entry)
        if option is None:
            continue
        if option.shortLabel in seen:
            duplicates.append(option.shortLabel)
            continue
        seen.add(option.shortLabel)
        options.append(option)
    return options, duplicates


@lru_cache
def get_presigned_url_ttl_options() -> tuple[dict[str, str | int], ...]:
    raw = os.environ.get("S3BROWSER_PRESIGNED_URL_TTLS")
    source = raw.strip() if raw and raw.strip() else DEFAULT_PRESIGNED_URL_TTLS
    options, duplicates = _parse_raw_ttls(source)
    if duplicates:
        unique = sorted(set(duplicates))
        noun = "entry" if len(unique) == 1 else "entries"
        raise RuntimeError(
            f"S3BROWSER_PRESIGNED_URL_TTLS contains duplicate {noun}: {', '.join(unique)}"
        )
    if not options:
        if raw and raw.strip():
            print(
                "presignedUrls: "
                f'S3BROWSER_PRESIGNED_URL_TTLS="{raw}" yielded no valid entries; '
                f'falling back to defaults "{DEFAULT_PRESIGNED_URL_TTLS}"'
            )
        options, _ = _parse_raw_ttls(DEFAULT_PRESIGNED_URL_TTLS)
    return tuple(
        {"ttl": option.ttl, "shortLabel": option.shortLabel, "longLabel": option.longLabel}
        for option in options
    )


@lru_cache
def get_search_whitelist_hosts() -> frozenset[str]:
    raw = os.environ.get(SEARCH_WHITELIST_ENV_VAR, "")
    return frozenset(entry.strip().lower() for entry in raw.split(",") if entry.strip())


load_config_file()
