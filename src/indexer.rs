//! `s3browser index`: crawl a bucket into the search index. Keys and metadata
//! are stored for every object, and the first 2 MiB of likely-text objects
//! for content search. Runs are incremental: unchanged objects are not
//! fetched again, and rows for deleted objects are swept at the end.

use std::collections::HashSet;
use std::time::Instant;

use anyhow::{Context, bail};

use crate::cli::IndexArgs;
use crate::config::{Config, SEARCH_WHITELIST_ENV_VAR};
use crate::db::{Db, IndexDb, IndexRow};
use crate::lock::FileLock;
use crate::s3::{S3Context, S3Factory, S3ResultExt, effective_endpoint_host};
use crate::session::now_secs;

const MAX_CONTENT_BYTES: i64 = 2 * 1024 * 1024;
const SLOW_FETCH_MS: u128 = 1000;

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "rst", "json", "jsonc", "jsonl", "ndjson", "csv", "tsv", "log", "xml", "html", "htm",
    "yml", "yaml", "toml", "ini", "conf", "cfg", "env", "css", "scss", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx",
    "vue", "svelte", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "sh", "bash", "zsh",
    "fish", "ps1", "sql", "tf", "hcl", "gitignore", "editorconfig", "lock",
];
const TEXT_BASENAMES: &[&str] = &[
    "readme", "license", "licence", "copying", "authors", "changelog", "makefile", "dockerfile", "jenkinsfile",
    "procfile",
];
const TEXT_APP_TYPES: &[&str] = &[
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/javascript",
    "application/ecmascript",
    "application/x-sh",
    "application/x-shellscript",
    "application/sql",
];

fn has_text_extension(key: &str) -> bool {
    let base = key.rsplit('/').next().unwrap_or(key).to_lowercase();
    if TEXT_BASENAMES.contains(&base.as_str()) {
        return true;
    }
    base.rsplit_once('.').is_some_and(|(_, ext)| TEXT_EXTENSIONS.contains(&ext))
}

fn is_text_content_type(content_type: Option<&str>) -> bool {
    let Some(lower) = content_type.map(str::to_lowercase) else {
        return false;
    };
    lower.starts_with("text/") || TEXT_APP_TYPES.iter().any(|t| lower.starts_with(t))
}

#[derive(Debug, Default)]
pub struct Totals {
    pub added: u64,
    pub updated: u64,
    pub touched: u64,
    pub removed: u64,
    pub seen: u64,
    pub body_fetched: u64,
    pub body_skipped_unchanged: u64,
    pub body_skipped_non_text: u64,
    pub body_skipped_size: u64,
    pub head_check_errors: u64,
    pub body_fetch_errors: u64,
}

struct Pending {
    row: IndexRow,
    needs_body_fetch: bool,
    needs_head_check: bool,
}

pub async fn run_command(config: Config, args: IndexArgs) -> anyhow::Result<()> {
    config.paths.ensure_dir()?;
    let _lock = FileLock::acquire(&config.paths.index_lock())?;
    if args.reset {
        println!("Deleting and recreating the search index database...");
        IndexDb::reset(&config.paths.index_db()).await?.close().await;
        println!("Search index database is empty.");
        return Ok(());
    }
    let connection_id = args.connection.context("--connection is required")?;
    let db = Db::open(&config.paths.db(), &config.encryption_key_source()?).await?;
    let result = async {
        let connection = db
            .connection(connection_id)
            .await?
            .with_context(|| format!("Connection {connection_id} not found in DB"))?;
        let endpoint_host = whitelisted_host(&config.search_whitelist_hosts(), connection.id, &connection.endpoint)?;
        let index_db = IndexDb::open(&config.paths.index_db()).await?;
        let context = S3Factory::new().await.context(&db, connection, args.bucket).await?;
        let result = index_bucket(&context, &index_db, &endpoint_host, args.batch_size).await;
        index_db.close().await;
        result
    }
    .await;
    db.close().await;
    result.map(|_| ())
}

/// Refuse to touch S3 unless the connection's endpoint host is allowlisted.
fn whitelisted_host(whitelist: &HashSet<String>, connection_id: i64, endpoint: &str) -> anyhow::Result<String> {
    match effective_endpoint_host(Some(endpoint)) {
        None => bail!(
            "Refusing to index: connection {connection_id} has no explicit endpoint set. Set the endpoint URL on \
             the connection and add its host to {SEARCH_WHITELIST_ENV_VAR}."
        ),
        Some(host) if !whitelist.contains(&host) => bail!(
            "Refusing to index: connection {connection_id} endpoint host \"{host}\" is not in {SEARCH_WHITELIST_ENV_VAR}."
        ),
        Some(host) => Ok(host),
    }
}

pub async fn index_bucket(context: &S3Context, index_db: &IndexDb, endpoint_host: &str, batch_size: i32) -> anyhow::Result<Totals> {
    let bucket = context
        .credentials
        .bucket
        .as_deref()
        .context("No bucket specified and connection has no default bucket")?;
    let client = &context.client;
    println!(
        "Indexing s3://{bucket} for connection {} ({}) at {endpoint_host}",
        context.connection.id, context.connection.profile_name
    );
    let indexed_bucket_id = index_db.get_or_create_bucket(endpoint_host, bucket).await?;
    let run_started_at = index_db.next_run_stamp(indexed_bucket_id, now_secs()).await?;
    let start = Instant::now();
    let mut totals = Totals::default();
    let mut continuation_token: Option<String> = None;
    let mut page_number = 0;
    loop {
        let response = client
            .list_objects_v2()
            .bucket(bucket)
            .max_keys(batch_size)
            .set_continuation_token(continuation_token.take())
            .send()
            .await
            .s3_context("ListObjectsV2")?;
        page_number += 1;

        let mut pending = Vec::with_capacity(response.contents().len());
        for item in response.contents() {
            let key = item
                .key()
                .filter(|k| !k.is_empty())
                .context("S3 ListObjectsV2 returned a Contents row without a Key")?;
            let last_modified = item.last_modified().context("S3 ListObjectsV2 returned no LastModified")?;
            let size = item.size();
            let (mut needs_body_fetch, mut needs_head_check) = (false, false);
            if !key.ends_with('/') && size != Some(0) {
                if has_text_extension(key) {
                    if size.is_some_and(|s| s > MAX_CONTENT_BYTES) {
                        totals.body_skipped_size += 1;
                    } else {
                        needs_body_fetch = true;
                    }
                } else if size.is_none_or(|s| s <= MAX_CONTENT_BYTES) {
                    needs_head_check = true;
                }
            }
            pending.push(Pending {
                row: IndexRow {
                    key: key.to_string(),
                    last_modified: last_modified.secs(),
                    size,
                    content: None,
                },
                needs_body_fetch,
                needs_head_check,
            });
        }
        totals.seen += pending.len() as u64;

        let keys: Vec<&str> = pending.iter().map(|p| p.row.key.as_str()).collect();
        let existing = index_db.last_modified_by_key(indexed_bucket_id, &keys).await?;
        for item in &mut pending {
            if (item.needs_body_fetch || item.needs_head_check)
                && existing.get(&item.row.key) == Some(&item.row.last_modified)
            {
                item.needs_body_fetch = false;
                item.needs_head_check = false;
                totals.body_skipped_unchanged += 1;
            }
        }

        for item in &mut pending {
            let key = item.row.key.as_str();
            if item.needs_head_check {
                item.needs_head_check = false;
                let started = Instant::now();
                match client.head_object().bucket(bucket).key(key).send().await.s3_context("HeadObject") {
                    Err(e) => {
                        println!("  HEAD failed key={key}: {e:#}");
                        totals.head_check_errors += 1;
                        continue;
                    }
                    Ok(head) => {
                        let elapsed = started.elapsed().as_millis();
                        if elapsed > SLOW_FETCH_MS {
                            println!("  slow HEAD {elapsed}ms key={key}");
                        }
                        if is_text_content_type(head.content_type()) {
                            item.needs_body_fetch = true;
                        } else {
                            totals.body_skipped_non_text += 1;
                        }
                    }
                }
            }
            if item.needs_body_fetch {
                item.needs_body_fetch = false;
                let started = Instant::now();
                let body = async {
                    let response = client
                        .get_object()
                        .bucket(bucket)
                        .key(key)
                        .range(format!("bytes=0-{}", MAX_CONTENT_BYTES - 1))
                        .send()
                        .await
                        .s3_context("GetObject")?;
                    anyhow::Ok(response.body.collect().await?.into_bytes())
                };
                match body.await {
                    Err(e) => {
                        println!("  GET failed key={key}: {e:#}");
                        totals.body_fetch_errors += 1;
                        continue;
                    }
                    Ok(bytes) => {
                        let elapsed = started.elapsed().as_millis();
                        if elapsed > SLOW_FETCH_MS {
                            let size = item.row.size.map_or("?".to_string(), |s| s.to_string());
                            println!("  slow GET {elapsed}ms key={key} size={size}");
                        }
                        item.row.content = Some(String::from_utf8_lossy(&bytes).into_owned());
                        totals.body_fetched += 1;
                    }
                }
            }
        }

        let rows: Vec<IndexRow> = pending.into_iter().map(|p| p.row).collect();
        let counts = index_db.upsert_batch(indexed_bucket_id, run_started_at, &rows).await?;
        totals.added += counts.added;
        totals.updated += counts.updated;
        totals.touched += counts.touched;
        println!(
            "Page {page_number}: {} keys seen, {} bodies fetched, elapsed {:.1}s",
            totals.seen,
            totals.body_fetched,
            start.elapsed().as_secs_f64()
        );
        continuation_token = response
            .next_continuation_token()
            .filter(|t| response.is_truncated() == Some(true) && !t.is_empty())
            .map(str::to_string);
        if continuation_token.is_none() {
            break;
        }
    }
    println!("Sweeping stale index rows after {} indexed keys...", totals.seen);
    totals.removed = index_db.sweep_stale(indexed_bucket_id, run_started_at).await?;
    index_db.mark_completed(indexed_bucket_id, totals.seen as i64).await?;
    println!(
        "Done. Indexed {} keys (added={}, updated={}, touched={}, removed={}) in {:.1}s",
        totals.seen,
        totals.added,
        totals.updated,
        totals.touched,
        totals.removed,
        start.elapsed().as_secs_f64()
    );
    println!(
        "Content: fetched={}, skipped(unchanged)={}, skipped(non-text)={}, skipped(over-cap)={}",
        totals.body_fetched, totals.body_skipped_unchanged, totals.body_skipped_non_text, totals.body_skipped_size
    );
    Ok(totals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_detection() {
        for key in ["a/README", "notes.MD", "x/y/config.yaml", "Dockerfile", ".gitignore", "Cargo.lock"] {
            assert!(has_text_extension(key), "{key}");
        }
        for key in ["photo.jpg", "a/b/noext", "archive.tar.gz", "dir/"] {
            assert!(!has_text_extension(key), "{key}");
        }
        assert!(is_text_content_type(Some("Text/Plain; charset=utf-8")));
        assert!(is_text_content_type(Some("application/json")));
        assert!(!is_text_content_type(Some("application/octet-stream")));
        assert!(!is_text_content_type(None));
    }

    #[test]
    fn whitelist_is_required() {
        let whitelist = HashSet::from(["minio.local".to_string()]);
        assert_eq!(whitelisted_host(&whitelist, 1, "https://MINIO.local:9000").unwrap(), "minio.local");
        let error = whitelisted_host(&whitelist, 1, "").unwrap_err().to_string();
        assert!(error.contains("has no explicit endpoint set"), "{error}");
        let error = whitelisted_host(&whitelist, 2, "http://other.host").unwrap_err().to_string();
        assert!(error.contains("\"other.host\" is not in S3BROWSER_SEARCH_WHITELIST_HOSTS"), "{error}");
    }
}
