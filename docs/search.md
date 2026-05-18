# Key Search

This document describes the local key search feature: how the index is built, how queries are served, and how the page is wired.

## Scope

- `server/db/index.ts` — schema for `s3_indexed_buckets` and `s3_object_index`, plus the upsert / sweep / search helpers.
- `server/routes/objects.ts` — `GET /search` and `GET /index-status` endpoints.
- `scripts/index-s3-keys.ts` — CLI that crawls a bucket and populates the index.
- `src/services/api/objects.ts` — `searchObjects()` and `getIndexStatus()`.
- `src/router.tsx` — `/connection/:connectionId/search/:bucket` route.
- `src/pages/SearchPage.tsx` — the search UI.
- `src/components/Toolbar/Toolbar.tsx` — the Search button on browse.

## Overview

Search runs against a **local SQLite index** in `~/.s3browser/s3browser.db`, not against S3 itself. The index has to be built by a CLI command before search will return any results, and it must be rebuilt to pick up bucket changes.

Match is a case-sensitive **SQL `LIKE` substring** against the full S3 key — no full-text tokenization, no glob support. Results can be sorted by key or by S3 `LastModified`.

## Endpoint host allowlist

Both indexing and search call `ListObjectsV2`, which is the expensive operation on S3 (cost per request scales with object count). To keep this opt-in per endpoint, search/indexing is gated by an environment variable:

```
S3BROWSER_SEARCH_WHITELIST_HOSTS=<comma-separated hostnames>
```

- The hostname is parsed from each connection's saved `endpoint` URL and compared exactly (case-insensitive) against the list.
- Connections with **no explicit endpoint** (i.e. AWS) match the literal `s3.amazonaws.com`. Add that entry to enable search for AWS connections.
- If the env var is **unset or empty**, search and indexing are disabled for every connection.
- Read once at server startup; restart the server to pick up changes.

Implementation: `server/config/searchWhitelist.ts`. The check is applied in three places:

| Surface                              | Behavior when host is not allowlisted                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `GET /index-status` and `GET /search`| `403` with `{ "code": "EndpointNotWhitelisted", "error": "..." }`                       |
| `bun run index:keys` CLI             | Exits non-zero before any S3 call, printing the host that would need to be allowlisted |
| Connection responses in `/api/auth/*`| Include `searchEnabled: boolean` so the UI can disable the Search button up front       |

In the UI, the Search button (Toolbar + mobile dropdown) is rendered as disabled with an explanatory tooltip when the active connection is not allowlisted. Direct navigation to `/connection/:id/search/:bucket` for a disallowed connection shows an Alert pointing to the env var.

## Schema

Two tables, both created on first startup by `initializeDatabase()`:

```sql
s3_indexed_buckets (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER,           -- FK -> s3_connections.id, ON DELETE CASCADE
  bucket TEXT,
  last_completed_at INTEGER,       -- unix epoch SECONDS; NULL until first crawl completes
  object_count INTEGER,
  UNIQUE(connection_id, bucket)
)

s3_object_index (
  id INTEGER PRIMARY KEY,
  indexed_bucket_id INTEGER,       -- FK -> s3_indexed_buckets.id, ON DELETE CASCADE
  key TEXT NOT NULL,
  last_modified INTEGER NOT NULL,  -- unix epoch SECONDS, from S3 LastModified
  size INTEGER,
  etag TEXT,
  seen_at INTEGER NOT NULL,        -- unix epoch SECONDS; set on every indexer pass
  UNIQUE(indexed_bucket_id, key)
)
```

**All timestamp columns are unix epoch seconds**, matching SQLite's `unixepoch()`. The route and API layers convert to/from JS `Date` via `* 1000`.

The `s3_indexed_buckets` parent table exists so the per-key rows reference a single integer instead of repeating `(connection_id, bucket)` text on every row.

## Indexer CLI

```sh
bun run index:keys -- --connection <id> [--bucket <name>] [--batch-size <n>] [--dry-run]
```

- `--connection <id>` is required and is the DB primary key of a saved connection.
- `--bucket <name>` defaults to the connection's saved bucket.
- `--batch-size` controls how many objects are processed per DB transaction (default 1000).
- `--dry-run` walks the bucket but does not write to the index.

The crawl uses `ListObjectsV2` with no `Delimiter`, so every object is enumerated flat.

### Incremental behavior

For each object the indexer runs one of three branches per row:

| Existing row | `last_modified` match? | Action               | FTS-like overhead |
| ------------ | ---------------------- | -------------------- | ----------------- |
| no           | n/a                    | INSERT               | one INSERT        |
| yes          | yes                    | UPDATE seen_at only  | minimal touch     |
| yes          | no                     | UPDATE all metadata  | one UPDATE        |

After every page is processed the indexer runs a **stale sweep**:

```sql
DELETE FROM s3_object_index
WHERE indexed_bucket_id = ? AND seen_at < <run_started_at>
```

This removes any row not touched during the current run, i.e. objects that no longer exist in the bucket. Then `last_completed_at` is set to `unixepoch()`.

If the indexer errors out mid-run, `last_completed_at` is **not** updated, so the UI's freshness banner continues to show the previous successful timestamp.

`item.Key` and `item.LastModified` are required from `ListObjectsV2` — the indexer throws if S3 returns a `Contents` row missing either.

## API endpoints

Both require the standard auth + connection middleware.

### `GET /api/objects/:connectionId/:bucket/index-status`

Returns the freshness banner data:

```json
{ "lastIndexedAt": "2026-05-18T03:14:07.000Z", "objectCount": 12345 }
```

`lastIndexedAt` is `null` when no completed crawl exists.

### `GET /api/objects/:connectionId/:bucket/search`

Query parameters:

- `q` — search term, required.
- `limit` — 1–500, default 100.
- `offset` — 0+, default 0.
- `sort` — `key` (default) or `last_modified`.
- `dir` — `asc` (default) or `desc`.

Search is always bucket-wide; there is no `prefix` parameter and the URL has no path suffix.

Returns:

```json
{
  "objects": [...],          // shaped like the listing endpoint's S3Object
  "total": 42,
  "lastIndexedAt": "2026-05-18T03:14:07.000Z",
  "objectCount": 12345
}
```

When no index exists for the bucket, the server returns `404` with `code: "IndexNotBuilt"` and an error message containing the exact CLI command to run.

## Frontend

The Search button in the browse toolbar navigates to `/connection/<id>/search/<bucket>`. The page uses URL search params for all interactive state so links and bookmarks survive reload:

- `?q=...` — the query.
- `?sort=key|last_modified` — sort column.
- `?dir=asc|desc` — direction.

Pagination uses local state (`offset`) and is reset to 0 on every query/sort change.

## Trust boundary

Object keys are stored unencrypted in the local SQLite DB. The trust boundary matches the existing object-listing endpoint — if reading a bucket's objects is acceptable, storing those keys locally is too.

The secret access key for the connection is encrypted at rest as before; only the listing metadata (key, size, last-modified, etag) is plaintext.
