from __future__ import annotations

import argparse

import pytest

from s3browser.cli import BindAddress, parse_bind_address


@pytest.mark.parametrize(
    ("bind", "expected"),
    [
        (None, BindAddress(host=None, port=8170)),
        ("", BindAddress(host=None, port=8170)),
        ("8170", BindAddress(host=None, port=8170)),
        (":3000", BindAddress(host=None, port=3000)),
        ("127.0.0.1:3000", BindAddress(host="127.0.0.1", port=3000)),
        ("[::1]:3000", BindAddress(host="::1", port=3000)),
        ("127.0.0.1", BindAddress(host="127.0.0.1", port=8170)),
    ],
)
def test_parse_bind_address_host_port_forms(bind: str | None, expected: BindAddress) -> None:
    assert parse_bind_address(bind) == expected


@pytest.mark.parametrize(
    ("bind", "path"),
    [
        ("unix:/run/s3browser.sock", "/run/s3browser.sock"),
        ("unix:./s3browser.sock", "./s3browser.sock"),
        ("unix:/tmp/dir with spaces/s3b.sock", "/tmp/dir with spaces/s3b.sock"),
    ],
)
def test_parse_bind_address_unix_socket(bind: str, path: str) -> None:
    result = parse_bind_address(bind)
    assert result == BindAddress(host=None, port=8170, uds=path)
    assert result.uds == path


def test_parse_bind_address_unix_requires_path() -> None:
    with pytest.raises(argparse.ArgumentTypeError):
        parse_bind_address("unix:")


def _resolve_bind(flag: str | None, env: str | None) -> BindAddress:
    # Mirrors the precedence logic in cli.main: flag wins over env var.
    return parse_bind_address(flag or env)


def test_bind_flag_overrides_env() -> None:
    assert _resolve_bind(":9000", ":8099") == BindAddress(host=None, port=9000)


def test_bind_env_used_when_flag_absent() -> None:
    assert _resolve_bind(None, ":8099") == BindAddress(host=None, port=8099)
    assert _resolve_bind(None, "unix:/run/s3browser.sock") == BindAddress(
        host=None, port=8170, uds="/run/s3browser.sock"
    )


def test_bind_falls_back_to_default_when_both_absent() -> None:
    assert _resolve_bind(None, None) == BindAddress(host=None, port=8170)
