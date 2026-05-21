#!/usr/bin/env bash

set -euo pipefail

print_info() {
  printf '[INFO] %s\n' "$1"
}

print_error() {
  printf '[ERROR] %s\n' "$1" >&2
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    print_error "Required command not found: $1"
    exit 1
  fi
}

if [[ ! -f pyproject.toml || ! -f package.json || ! -d src || ! -d s3browser ]]; then
  print_error "Run this script from the s3browser source checkout."
  exit 1
fi

require_command bun
require_command uv

print_info "Installing frontend dependencies"
bun install

print_info "Building frontend assets"
bun run build:client

print_info "Installing s3browser with uv tool"
uv tool install . --force

print_info "Installed. Run: s3browser server"