from __future__ import annotations

from pathlib import Path
from types import TracebackType

from filelock import FileLock as _FileLock
from filelock import Timeout

from s3browser.paths import ensure_app_dir


class FileLock:
    def __init__(self, path: Path):
        self.path = path
        self._lock: _FileLock | None = None

    def acquire(self) -> None:
        ensure_app_dir()
        lock = _FileLock(str(self.path))
        try:
            lock.acquire(timeout=0)
        except Timeout as error:
            raise RuntimeError(
                f"Another s3browser process is already running ({self.path})"
            ) from error
        self._lock = lock

    def release(self) -> None:
        if self._lock is None:
            return
        lock = self._lock
        self._lock = None
        lock.release()

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
