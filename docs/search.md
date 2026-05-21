# Key Search

Local substring search over S3 object keys. Search runs against a SQLite index in `~/.s3browser/s3browser.db`, not against S3 — the index is populated by a CLI command and only reflects bucket state as of its last run.

## Endpoint host allowlist

Indexing and search both depend on `ListObjectsV2`, which can be expensive on large buckets. Both are opt-in per S3 endpoint via:

```
S3BROWSER_SEARCH_WHITELIST_HOSTS=<comma-separated hostnames>
```

- Compared exactly (case-insensitive) against the hostname of each connection's saved endpoint URL.
- Connections with **no explicit endpoint set** are never allowlisted. To enable search on AWS, set the AWS S3 endpoint URL on the connection (e.g. `https://s3.amazonaws.com` or a regional variant) and add that hostname to the env var.
- Unset or empty → search and indexing are disabled for every connection. This is the default.
- Read once at server startup; restart to pick up changes.

When a connection isn't allowlisted, the search/index-status API routes refuse with a 4xx, the indexer CLI exits before any S3 call, and the UI surfaces the Search button as disabled with an explanatory tooltip.

## Building the index

```sh
s3browser index --connection <id> [--bucket <name>] [--batch-size <n>]
```

`--connection` is the DB id of a saved connection. `--bucket` defaults to the connection's saved bucket. `--batch-size` controls S3 page/write loop size; DB writes are committed row by row. Run `--help` for the full flag list.

The crawl is incremental: rows whose `LastModified` matches what's already indexed are touched, not rewritten, and objects no longer present in the bucket are deleted at the end of each run. The "last indexed at" timestamp only advances on a clean run, so a failed crawl leaves the UI's freshness banner pointing at the previous good state.

## Search semantics

- Case-sensitive `LIKE` substring against the full S3 key. No tokenization or globbing.
- Bucket-wide; no prefix filter.
- Sortable by `key` or `last_modified`, either direction.

The Search page is at `/connection/:connectionId/search/:bucket`. Query, sort, and direction live in URL search params so links and reloads work.

## Trust boundary

Keys, sizes, last-modified, and etags are stored unencrypted in the local SQLite DB. The trust boundary matches the existing object-listing endpoint — if listing a bucket is acceptable, persisting its listing metadata locally is too. Connection secret keys remain encrypted at rest.

## Source pointers

- Whitelist + gate: `s3browser/config.py` (`get_search_whitelist_hosts`)
- Schema + upsert/sweep/search helpers: `s3browser/db.py`
- API routes: `s3browser/routers/objects.py`
- Indexer CLI: `s3browser/cli.py` (`index` subcommand), `s3browser/indexing.py`
- Search page + Toolbar button: `frontend/src/pages/SearchPage.tsx`, `frontend/src/components/Toolbar/Toolbar.tsx`
