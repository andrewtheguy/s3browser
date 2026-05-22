from __future__ import annotations

import pytest

from s3browser.server import _is_static_asset_path


@pytest.mark.parametrize(
    "path",
    [
        "assets/index-abc123.js",
        "assets/main.css",
        "favicon.ico",
        "vite.svg",
        "robots.txt",
        "manifest.json",
    ],
)
def test_root_level_or_assets_paths_are_static_assets(path: str) -> None:
    assert _is_static_asset_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "connection/2/browse/radio-show/transcripts/rthk-radio2/2026/05/21/",
        # Regression: SPA preview route ending in .json must fall back to index.html,
        # not 404. Previously broken because Path(...).suffix matched the .json.
        "connection/2/preview/radio-show/transcripts/rthk-radio2/2026/05/21/"
        "20260521_2200_0000_transcript.json",
        "connection/2/preview/bucket/path/file.m4a",
        "connection/2/preview/bucket/path/note.with.dots.txt",
        "settings",
        "login",
    ],
)
def test_spa_routes_are_not_static_assets(path: str) -> None:
    assert _is_static_asset_path(path) is False
