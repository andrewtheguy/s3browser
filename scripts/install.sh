#!/usr/bin/env bash
set -euo pipefail

REPO="andrewtheguy/s3browser"

if ! command -v uv >/dev/null 2>&1; then
    echo "error: 'uv' is not installed or not on PATH." >&2
    echo "Install it from https://docs.astral.sh/uv/getting-started/installation/" >&2
    exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
    echo "error: 'curl' is required to fetch the latest release metadata." >&2
    exit 1
fi

api_url="https://api.github.com/repos/${REPO}/releases/latest"
wheel_url=$(
    curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        "${api_url}" \
    | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*/s3browser-[^"/]*-py3-none-any\.whl"' \
    | head -n1 \
    | sed -E 's/.*"(https:[^"]+)"$/\1/'
)

if [[ -z "${wheel_url}" ]]; then
    echo "error: could not find an s3browser-*-py3-none-any.whl asset in the latest release of ${REPO}." >&2
    exit 1
fi

echo "Installing ${wheel_url##*/} with uv tool install..."
uv tool install --force "${wheel_url}"
