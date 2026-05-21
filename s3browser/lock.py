from __future__ import annotations

import fcntl
from pathlib import Path
from types import TracebackType
from typing import TextIO

from s3browser.paths import ensure_app_dir


class FileLock:
    def __init__(self, path: Path):
        self.path = path
        self._handle: TextIO | None = None

    def acquire(self) -> None:
        ensure_app_dir()
        handle = self.path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            handle.close()
            raise RuntimeError(
                f"Another s3browser process is already running ({self.path})"
            ) from error
        self._handle = handle

    def release(self) -> None:
        if self._handle is None:
            return
        handle = self._handle
        self._handle = None
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()

    def __enter__(self) -> FileLock:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.release()
