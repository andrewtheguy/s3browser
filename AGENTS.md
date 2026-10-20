# AI Agent Instructions

Strict no backward compatibility or legacy code path no matter what.

## Project layout

- Backend: Rust (axum + sqlx/SQLite + aws-sdk-s3) at the repo root (`src/`), one binary `s3browser` with `server` and `index` subcommands. Every build, debug included, embeds the frontend (`build.rs` runs `bun run build` → `src/assets.rs`); there is no dev server.
- Frontend: Vite + React + TypeScript in `frontend/`. Package manager: `bun` (never npm).
- Search/indexing is documented in `docs/search.md`; preview hardening in `docs/preview-security.md`.

## Validation commands

Run these before reporting a task complete. All must exit clean.

### Backend (run from repo root)

```
cargo clippy --all-targets -- -D warnings
cargo test
```

No `cargo fmt`.

When a change touches the indexer, SQL, S3 access, or HTTP behaviour, also run
the end-to-end suite (real binary against a Silo S3 server, downloaded into
`tmp/tools` on first run):

```
./scripts/e2e.sh
```

### Frontend (run from `frontend/`)

```
bun run lint --reporter=rdjson   # biome lint
bun run typecheck                # tsc
```

## Running locally

Don't run by default, but if you do need to run, use these commands from the repo root:

```
cargo run -- server --bind 127.0.0.1:8170   # whole app at http://127.0.0.1:8170
cargo run -- index --connection 1           # one-shot S3 → search index crawl
```

After a frontend change, rerun `cargo run` (or `cargo build`) before checking it in the browser: the bundle is compiled into the binary.

## Conventions

- The package version lives only in `Cargo.toml`; `frontend/package.json` has no version field. Bump it before running the release workflow, which refuses an existing tag.
- Error handling: `anyhow` for application errors (main, indexer, S3 helpers), `thiserror` for the typed API error (`AppError` in `src/error.rs`), which always renders `{"error": "...", "code"?: "..."}`; internal/upstream errors return a generic message to clients and log the chain.
- The API contract (routes, JSON shapes, the `s3browser_auth_token` cookie) is what `frontend/src/services/api/` expects; change both sides together.
- On-disk state lives in `~/.s3browser` (`src/paths.rs`).
- Use the async Rust APIs by default.
- Use `tmp/` for temporary files (gitignored).
