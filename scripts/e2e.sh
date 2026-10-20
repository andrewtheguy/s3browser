#!/usr/bin/env bash

# End-to-end tests: runs the real `s3browser` binary (`server` and `index`)
# against a Silo S3 server, then tears it down.
#
#   ./scripts/e2e.sh                 # whole suite (tests/e2e.rs)
#   ./scripts/e2e.sh search          # only tests whose name contains "search"
#
# Silo (https://github.com/pgsty/silo) is a MinIO fork: one binary, a data
# directory, and root credentials in the environment. Its configuration and
# health surfaces are still MinIO's, hence the `MINIO_*` variables and the
# `/minio/health/live` probe. It is downloaded once into tmp/tools and
# checksum-verified.
#
# Every test runs the binary with its own HOME (so its own ~/.s3browser) and
# its own bucket, so tests run in parallel and leave nothing behind.
#
# Environment: SILO_S3_PORT (default 9410), SILO_BIN (an existing Silo binary).

set -euo pipefail

SILO_RELEASE="RELEASE.2026-09-16T00-00-00Z"
SILO_VERSION="20260916000000.0.0"
# SHA-256 of the official linux archives for the release above.
SILO_SHA256_AMD64="381e745510a8fb64323d7bb3207f95984b7f4ed826f4fcad318f97683c420c73"
SILO_SHA256_ARM64="6e697d3e1d70f2343fe829cd6820a0b840d4619f1dde546424de80e529636ed2"
SILO_ACCESS_KEY="s3browser-e2e"
SILO_SECRET_KEY="s3browser-e2e-secret"
SILO_REGION="us-east-1"
SILO_S3_PORT="${SILO_S3_PORT:-9410}"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime="${project_root}/tmp/e2e"
silo_binary="${SILO_BIN:-${project_root}/tmp/tools/silo-${SILO_VERSION}}"

info() {
    printf '[e2e] %s\n' "$*"
}

fail() {
    printf '[e2e] ERROR: %s\n' "$*" >&2
    exit 1
}

[[ "$SILO_S3_PORT" =~ ^[0-9]+$ ]] && (( SILO_S3_PORT >= 1 && SILO_S3_PORT <= 65535 )) ||
    fail "SILO_S3_PORT must be an integer from 1 through 65535"

download_silo() {
    local arch expected_sha256 actual_sha256 archive
    [[ "$(uname -s)" == "Linux" ]] || fail "set SILO_BIN to a Silo ${SILO_RELEASE} binary"
    case "$(uname -m)" in
        x86_64) arch="amd64"; expected_sha256="$SILO_SHA256_AMD64" ;;
        aarch64 | arm64) arch="arm64"; expected_sha256="$SILO_SHA256_ARM64" ;;
        *) fail "set SILO_BIN to a Silo ${SILO_RELEASE} binary" ;;
    esac
    mkdir -p "$(dirname "$silo_binary")"
    archive="${silo_binary}.tar.gz"
    info "downloading Silo ${SILO_RELEASE} (linux/${arch})"
    curl --fail --location --silent --show-error --output "$archive" \
        "https://github.com/pgsty/silo/releases/download/${SILO_RELEASE}/silo_${SILO_VERSION}_linux_${arch}.tar.gz"
    actual_sha256="$(sha256sum "$archive" | awk '{ print $1 }')"
    if [[ "$actual_sha256" != "$expected_sha256" ]]; then
        rm -f "$archive"
        fail "Silo checksum mismatch: expected ${expected_sha256}, got ${actual_sha256}"
    fi
    # The archive carries the server as a bare `silo` at its root.
    tar -xzf "$archive" -O silo >"${silo_binary}.download"
    rm -f "$archive"
    chmod +x "${silo_binary}.download"
    mv "${silo_binary}.download" "$silo_binary"
}

wait_for() {
    local what="$1"
    shift
    for _ in $(seq 1 60); do
        if "$@" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.5
    done
    fail "${what} did not become ready"
}

silo_pid=""

cleanup() {
    if [[ -n "$silo_pid" ]]; then
        kill "$silo_pid" 2>/dev/null || true
        wait "$silo_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT

[[ -x "$silo_binary" ]] || download_silo

# A fresh data directory per run; this path is disposable, under tmp/.
rm -rf "$runtime"
mkdir -p "${runtime}/silo-data"

info "starting Silo on 127.0.0.1:${SILO_S3_PORT} (log: tmp/e2e/silo.log)"
MINIO_ROOT_USER="$SILO_ACCESS_KEY" \
    MINIO_ROOT_PASSWORD="$SILO_SECRET_KEY" \
    MINIO_REGION="$SILO_REGION" \
    "$silo_binary" server "${runtime}/silo-data" \
    --address "127.0.0.1:${SILO_S3_PORT}" --quiet >"${runtime}/silo.log" 2>&1 &
silo_pid=$!
wait_for "Silo" curl --fail --silent --output /dev/null \
    "http://127.0.0.1:${SILO_S3_PORT}/minio/health/live"

export S3BROWSER_E2E_S3_ENDPOINT="http://127.0.0.1:${SILO_S3_PORT}"
export S3BROWSER_E2E_S3_ACCESS_KEY_ID="$SILO_ACCESS_KEY"
export S3BROWSER_E2E_S3_SECRET_ACCESS_KEY="$SILO_SECRET_KEY"
export S3BROWSER_E2E_S3_REGION="$SILO_REGION"
cd "$project_root"

info "running tests/e2e.rs"
cargo test --test e2e -- --ignored "$@"
info "end-to-end tests passed"
