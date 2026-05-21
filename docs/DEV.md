# Developer guide

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- [bun](https://bun.sh/) for the frontend
- Go 1.23+ for VersityGW (only required to run end-to-end tests)

## One-time setup

```bash
uv sync
cd frontend && bun install --frozen-lockfile && cd ..
```

## Running the app locally

```bash
cd frontend && bun run build && cd ..
uv run s3browser server
```

## Running the test suite

The test suite is two-tiered: unit tests with no external dependencies, and end-to-end
tests that exercise the async S3 client against a real
[VersityGW](https://github.com/versity/versitygw) gateway.

### Unit tests (no setup required)

```bash
uv run pytest tests/unit
```

These cover SigV4 signing (against AWS's published test vectors), XML parsing,
error mapping, pagination, presigned URL generation, and the full request
lifecycle via `httpx.MockTransport`.

### End-to-end tests (need VersityGW)

Install VersityGW:

```bash
# Option A: go install
go install github.com/versity/versitygw@latest
export PATH="$PATH:$(go env GOPATH)/bin"

# Option B: Homebrew
brew install versitygw
```

Then run:

```bash
uv run pytest tests/e2e
```

The e2e suite spawns `versitygw posix` as a subprocess on a free port for the
duration of the test session and tears it down on exit. Each test gets a fresh
bucket. Tests are automatically skipped when `versitygw` is not on `$PATH`.

If you want to drive VersityGW interactively (for manual integration work):

```bash
mkdir -p "$(pwd)/tmp/s3-upload/dev" "$(pwd)/tmp/s3-sidecar"
ROOT_ACCESS_KEY=testkey ROOT_SECRET_KEY=testsecret \
  versitygw --port :7070 posix \
  --sidecar "$(pwd)/tmp/s3-sidecar" \
  "$(pwd)/tmp/s3-upload"
```

Point a saved connection at `http://localhost:7070` with the same credentials
and you can browse the `dev` bucket from the app.

## Lint, format, and type check

```bash
uv run ruff check
uv run ruff format --check
uv run basedpyright
```

Frontend equivalents:

```bash
cd frontend && bun run lint --reporter=rdjson
cd frontend && npx tsc
```

## Troubleshooting

- **`versitygw not installed`**: e2e tests skip automatically. Install per the
  instructions above and re-run.
- **`address already in use`**: a previous VersityGW process did not shut down.
  The fixture picks a free port each session, but stray processes can interfere.
  `pkill versitygw` and retry.
- **Stale tmp dirs**: the pytest tmp_path_factory cleans up after each session,
  but if a test crashed you may have leftovers under
  `/tmp/pytest-of-$USER/versitygw-data*` — safe to remove.
