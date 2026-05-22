# Search

Local substring search over indexed S3 object keys and small text-object contents. Search runs against a SQLite index in `~/.s3browser/s3browser-index.db`, not directly against S3. The index is populated by a CLI command and only reflects bucket state as of its last completed run.

## Endpoint host allowlist

Indexing depends on `ListObjectsV2` and may issue `HEAD`/ranged `GET` requests for text detection and content indexing, which can be expensive on large buckets. Search and indexing are both opt-in per S3 endpoint via:

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

`--connection` is the DB id of a saved connection. `--bucket` defaults to the connection's saved bucket. `--batch-size` controls S3 page/write loop size; DB writes are committed once per processed batch. Run `--help` for the full flag list.

The crawl is incremental: rows whose `LastModified` matches what's already indexed are touched, not rewritten, and objects no longer present in the bucket are deleted at the end of each run. The "last indexed at" timestamp only advances on a clean run, so a failed crawl leaves the UI's freshness banner pointing at the previous good state.

For each object, the index stores key, size, and last-modified metadata. It also stores text content for objects that are likely text and are at most 2 MiB:

- Known text extensions and basenames are fetched directly with a ranged `GET`.
- Unknown extensions at or below 2 MiB may receive a `HEAD` request; if the content type is text-like, the first 2 MiB are fetched.
- Non-text objects, directory marker objects, zero-byte objects, and text candidates over 2 MiB do not have content stored.

## Search semantics

- SQLite `LIKE` substring match against the full S3 key and indexed text content. This is not glob syntax.
- Indexed text content uses an FTS5 trigram table to accelerate substring matches.
- Bucket-wide by default, with optional prefix scope (`prefix`) and file extension filter (`ext`).
- Sortable by `key` or `last_modified`, either direction.
- Results include snippets and match counts when the match came from indexed text content.

The Search page is at `/connection/:connectionId/search/:bucket`. Query (`q`), prefix scope (`prefix`), extension filter (`ext`), sort (`sort`), and direction (`dir`) live in URL search params so links and reloads work.

## Trust boundary

Keys, sizes, last-modified timestamps, and indexed text content are stored unencrypted in the local search SQLite DB. The trust boundary is broader than object listing when content indexing is enabled: text-file contents up to 2 MiB may be persisted locally. Connection secret keys remain encrypted at rest in the main application DB.

## Source pointers

- Whitelist + gate: `s3browser/config.py` (`get_search_whitelist_hosts`)
- Paths: `s3browser/paths.py` (`INDEX_DB_PATH`, `INDEX_LOCK_FILE`)
- Schema + upsert/sweep/search helpers: `s3browser/db.py`
- API routes: `s3browser/routers/objects.py`
- Indexer CLI: `s3browser/cli.py` (`index` subcommand), `s3browser/indexing.py`
- Search page + Toolbar button: `frontend/src/pages/SearchPage.tsx`, `frontend/src/components/Toolbar/Toolbar.tsx`
