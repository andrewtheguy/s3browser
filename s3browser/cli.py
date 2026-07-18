from __future__ import annotations

import argparse
import asyncio
import os
import sys
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version

from s3browser.lock import FileLock
from s3browser.paths import INDEX_LOCK_FILE


@dataclass(frozen=True)
class BindAddress:
    host: str | None
    port: int
    uds: str | None = None


def _version() -> str:
    try:
        return version("s3browser")
    except PackageNotFoundError:
        from s3browser import __version__

        return __version__


def parse_positive_int(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if value <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return value


def parse_bind_address(bind: str | None) -> BindAddress:
    default_port = 8170
    if not bind:
        return BindAddress(host=None, port=default_port)
    if bind.startswith("unix:"):
        path = bind[len("unix:") :]
        if not path:
            raise argparse.ArgumentTypeError(
                'Invalid bind address "unix:": a socket path is required, '
                "e.g. unix:/tmp/s3browser.sock"
            )
        return BindAddress(host=None, port=default_port, uds=path)
    if bind.isdigit():
        return BindAddress(host=None, port=int(bind))
    if bind.startswith(":") and bind[1:].isdigit():
        return BindAddress(host=None, port=int(bind[1:]))
    if bind.startswith("[") and "]:" in bind:
        host, _, port = bind[1:].partition("]:")
        if port.isdigit():
            return BindAddress(host=host, port=int(port))
    last_colon = bind.rfind(":")
    if last_colon > 0 and not bind.startswith("[") and bind.find(":") != last_colon:
        raise argparse.ArgumentTypeError(
            f'Invalid bind address "{bind}": IPv6 must use bracket notation, '
            f"e.g. [{bind.rsplit(':', 1)[0]}]:{default_port}"
        )
    if last_colon > 0:
        port_raw = bind[last_colon + 1 :]
        return BindAddress(
            host=bind[:last_colon], port=int(port_raw) if port_raw.isdigit() else default_port
        )
    if ":" not in bind:
        return BindAddress(host=bind, port=default_port)
    return BindAddress(host=None, port=default_port)


def run_index(args: argparse.Namespace) -> int:
    from s3browser.db import get_connection_by_id
    from s3browser.indexing import index_s3_bucket, reset_index
    from s3browser.s3 import create_s3_context_from_connection

    async def _run() -> None:
        connection = get_connection_by_id(args.connection)
        if connection is None:
            raise RuntimeError(f"Connection {args.connection} not found in DB")
        async with create_s3_context_from_connection(connection, args.bucket) as context:
            await index_s3_bucket(context, batch_size=args.batch_size)

    try:
        with FileLock(INDEX_LOCK_FILE):
            if args.reset:
                reset_index()
            else:
                if args.connection is None:
                    print(
                        "error: required option '-c, --connection <id>' not specified",
                        file=sys.stderr,
                    )
                    return 2
                asyncio.run(_run())
    except Exception as error:
        print(error, file=sys.stderr)
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="s3browser", description="S3-compatible file manager and indexing CLI"
    )
    parser.add_argument("--version", action="version", version=_version())
    sub = parser.add_subparsers(dest="cmd", required=True)

    server_parser = sub.add_parser("server", help="Run the HTTP server with frontend assets")
    server_parser.add_argument(
        "-b",
        "--bind",
        type=parse_bind_address,
        help=(
            "Address to bind (e.g. :8170, 127.0.0.1:3000, [::1]:3000, "
            "unix:/tmp/s3browser.sock; socket paths are capped at 108 bytes); "
            "defaults to the S3BROWSER_BIND env var"
        ),
    )
    server_parser.add_argument(
        "--reload", action="store_true", help="Reload the server when Python files change"
    )

    index_parser = sub.add_parser("index", help="Index an S3 bucket for full-text search")
    index_parser.add_argument(
        "-c", "--connection", type=parse_positive_int, help="Saved S3 connection ID"
    )
    index_parser.add_argument(
        "--bucket", help="Bucket to index (defaults to the connection's saved bucket)"
    )
    index_parser.add_argument(
        "--batch-size",
        type=parse_positive_int,
        default=1000,
        help="Objects processed per S3 page/write loop",
    )
    index_parser.add_argument(
        "--reset", action="store_true", help="Delete the search index database and exit"
    )

    args = parser.parse_args()
    if args.cmd == "server":
        from s3browser.server import run

        # --bind is validated by argparse (type=parse_bind_address), so args.bind
        # is a BindAddress when supplied (even "" / default) and None otherwise.
        # Importing s3browser.server triggers config.load_config_file(), so the
        # S3BROWSER_BIND fallback (used only when --bind was omitted) reflects
        # config.toml values in os.environ by now.
        bind = (
            args.bind
            if args.bind is not None
            else parse_bind_address(os.environ.get("S3BROWSER_BIND"))
        )
        run(host=bind.host, port=bind.port, uds=bind.uds, reload=args.reload)
    elif args.cmd == "index":
        raise SystemExit(run_index(args))


if __name__ == "__main__":
    main()
