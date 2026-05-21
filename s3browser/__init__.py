"""Python backend package for s3browser."""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

__all__ = ["__version__"]

try:
    __version__ = _pkg_version("s3browser")
except PackageNotFoundError:
    __version__ = "0.0.0+unknown"
