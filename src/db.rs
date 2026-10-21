//! The two SQLite databases: `s3browser.db` holds saved connections (secret
//! keys encrypted, see `crypto`), `s3browser-index.db` the search index built
//! by `s3browser index`.

use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

use crate::crypto::{Cipher, SALT_LENGTH, base64_decode, base64_encode, random_bytes};

const KEY_CHECK_CANARY: &str = "s3browser-key-check-v1";
const DB_BUSY_TIMEOUT: Duration = Duration::from_millis(5000);
const INDEX_DB_BUSY_TIMEOUT: Duration = Duration::from_millis(30000);
/// SQLite's default host-parameter limit is far above this; it bounds one `IN (…)`.
const KEY_LOOKUP_CHUNK: usize = 500;

async fn connect(path: &Path, busy_timeout: Duration) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(busy_timeout)
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .with_context(|| format!("failed to open {}", path.display()))
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct S3Connection {
    pub id: i64,
    pub profile_name: String,
    pub endpoint: String,
    pub access_key_id: String,
    /// Encrypted; see [`Db::decrypt_secret`].
    pub secret_access_key: String,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub auto_detect_region: bool,
    pub last_used_at: i64,
}

/// A bucket the user opened on a connection; `last_used_at` is unix milliseconds.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct RecentBucket {
    pub connection_id: i64,
    pub bucket: String,
    pub last_used_at: i64,
}

/// How many recently opened buckets are remembered per connection.
pub const RECENT_BUCKETS_LIMIT: i64 = 8;

pub struct SaveConnection<'a> {
    pub id: Option<i64>,
    pub profile_name: &'a str,
    pub endpoint: &'a str,
    pub access_key_id: &'a str,
    /// `None` keeps the stored secret of an existing connection.
    pub secret_access_key: Option<&'a str>,
    pub bucket: Option<&'a str>,
    pub region: Option<&'a str>,
    pub auto_detect_region: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error("Profile name already exists")]
    DuplicateProfile,
    #[error("Connection not found")]
    NotFound,
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl From<sqlx::Error> for SaveError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::Database(db) if db.is_unique_violation() => Self::DuplicateProfile,
            _ => Self::Other(e.into()),
        }
    }
}

/// The connections database plus the cipher for its secrets.
#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
    cipher: Arc<Cipher>,
}

impl Db {
    /// Open (creating if needed) and check that `encryption_key_source` is the
    /// key the database was initialized with.
    pub async fn open(path: &Path, encryption_key_source: &str) -> anyhow::Result<Self> {
        let pool = connect(path, DB_BUSY_TIMEOUT).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await?;
        let salt = load_or_create_salt(&pool).await?;
        let key_source = encryption_key_source.to_string();
        let cipher = tokio::task::spawn_blocking(move || Cipher::new(&key_source, &salt)).await??;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS s3_connections (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               profile_name TEXT NOT NULL UNIQUE,
               endpoint TEXT NOT NULL,
               access_key_id TEXT NOT NULL,
               secret_access_key TEXT NOT NULL,
               bucket TEXT,
               region TEXT,
               auto_detect_region INTEGER DEFAULT 1,
               last_used_at INTEGER DEFAULT (unixepoch())
             )",
        )
        .execute(&pool)
        .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS s3_connection_recent_buckets (
               connection_id INTEGER NOT NULL REFERENCES s3_connections(id) ON DELETE CASCADE,
               bucket TEXT NOT NULL,
               last_used_at INTEGER NOT NULL,
               PRIMARY KEY (connection_id, bucket)
             ) WITHOUT ROWID",
        )
        .execute(&pool)
        .await?;
        let db = Self {
            pool,
            cipher: Arc::new(cipher),
        };
        db.verify_encryption_key().await?;
        Ok(db)
    }

    async fn verify_encryption_key(&self) -> anyhow::Result<()> {
        let stored: Option<String> = sqlx::query_scalar("SELECT value FROM metadata WHERE key = 'key_check'")
            .fetch_optional(&self.pool)
            .await?;
        let Some(stored) = stored else {
            let secrets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM s3_connections")
                .fetch_one(&self.pool)
                .await?;
            if secrets > 0 {
                bail!(
                    "Encryption key verification failed: key_check is missing, but encrypted connections exist. \
                     Use the original encryption key, or delete ~/.s3browser/s3browser.db to start fresh."
                );
            }
            sqlx::query("INSERT INTO metadata (key, value) VALUES ('key_check', ?)")
                .bind(self.cipher.encrypt(KEY_CHECK_CANARY))
                .execute(&self.pool)
                .await?;
            return Ok(());
        };
        if self.cipher.decrypt(&stored).ok().as_deref() != Some(KEY_CHECK_CANARY) {
            bail!(
                "Encryption key mismatch: The current encryption key does not match the one used to initialize \
                 the database. Use the original key, or delete ~/.s3browser/s3browser.db to start fresh."
            );
        }
        Ok(())
    }

    pub async fn connections(&self) -> sqlx::Result<Vec<S3Connection>> {
        sqlx::query_as("SELECT * FROM s3_connections ORDER BY last_used_at DESC")
            .fetch_all(&self.pool)
            .await
    }

    pub async fn connection(&self, id: i64) -> sqlx::Result<Option<S3Connection>> {
        sqlx::query_as("SELECT * FROM s3_connections WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
    }

    pub async fn save_connection(&self, input: SaveConnection<'_>) -> Result<S3Connection, SaveError> {
        let encrypted = input.secret_access_key.map(|secret| self.cipher.encrypt(secret));
        let id = match input.id {
            Some(id) => {
                let result = sqlx::query(
                    "UPDATE s3_connections SET
                       profile_name = ?, endpoint = ?, access_key_id = ?,
                       secret_access_key = COALESCE(?, secret_access_key),
                       bucket = ?, region = ?, auto_detect_region = ?, last_used_at = unixepoch()
                     WHERE id = ?",
                )
                .bind(input.profile_name)
                .bind(input.endpoint)
                .bind(input.access_key_id)
                .bind(encrypted)
                .bind(input.bucket)
                .bind(input.region)
                .bind(input.auto_detect_region)
                .bind(id)
                .execute(&self.pool)
                .await?;
                if result.rows_affected() == 0 {
                    return Err(SaveError::NotFound);
                }
                id
            }
            None => {
                let Some(encrypted) = encrypted else {
                    return Err(anyhow::anyhow!("Secret access key is required for new connections").into());
                };
                sqlx::query(
                    "INSERT INTO s3_connections
                       (profile_name, endpoint, access_key_id, secret_access_key, bucket, region,
                        auto_detect_region, last_used_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())",
                )
                .bind(input.profile_name)
                .bind(input.endpoint)
                .bind(input.access_key_id)
                .bind(encrypted)
                .bind(input.bucket)
                .bind(input.region)
                .bind(input.auto_detect_region)
                .execute(&self.pool)
                .await?
                .last_insert_rowid()
            }
        };
        self.connection(id).await?.ok_or(SaveError::NotFound)
    }

    pub async fn delete_connection(&self, id: i64) -> sqlx::Result<bool> {
        let result = sqlx::query("DELETE FROM s3_connections WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Mark a connection as used now and, when the request named a bucket,
    /// move that bucket to the front of the connection's recent buckets.
    pub async fn touch(&self, connection_id: i64, bucket: Option<&str>, now_ms: i64) -> sqlx::Result<()> {
        sqlx::query("UPDATE s3_connections SET last_used_at = unixepoch() WHERE id = ?")
            .bind(connection_id)
            .execute(&self.pool)
            .await?;
        let Some(bucket) = bucket else {
            return Ok(());
        };
        sqlx::query(
            "INSERT INTO s3_connection_recent_buckets (connection_id, bucket, last_used_at) VALUES (?, ?, ?)
             ON CONFLICT(connection_id, bucket) DO UPDATE SET last_used_at = excluded.last_used_at",
        )
        .bind(connection_id)
        .bind(bucket)
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "DELETE FROM s3_connection_recent_buckets
             WHERE connection_id = ? AND bucket NOT IN (
               SELECT bucket FROM s3_connection_recent_buckets WHERE connection_id = ?
               ORDER BY last_used_at DESC, bucket ASC LIMIT ?
             )",
        )
        .bind(connection_id)
        .bind(connection_id)
        .bind(RECENT_BUCKETS_LIMIT)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Recent buckets of every connection, most recent first within each connection.
    pub async fn recent_buckets(&self) -> sqlx::Result<Vec<RecentBucket>> {
        sqlx::query_as(
            "SELECT connection_id, bucket, last_used_at FROM s3_connection_recent_buckets
             ORDER BY connection_id, last_used_at DESC, bucket ASC",
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn recent_buckets_for(&self, connection_id: i64) -> sqlx::Result<Vec<RecentBucket>> {
        sqlx::query_as(
            "SELECT connection_id, bucket, last_used_at FROM s3_connection_recent_buckets
             WHERE connection_id = ? ORDER BY last_used_at DESC, bucket ASC",
        )
        .bind(connection_id)
        .fetch_all(&self.pool)
        .await
    }

    pub fn decrypt_secret(&self, connection: &S3Connection) -> anyhow::Result<String> {
        self.cipher
            .decrypt(&connection.secret_access_key)
            .with_context(|| format!("failed to decrypt the secret key of connection {}", connection.id))
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

async fn load_or_create_salt(pool: &SqlitePool) -> anyhow::Result<Vec<u8>> {
    let stored: Option<String> = sqlx::query_scalar("SELECT value FROM metadata WHERE key = 'encryption_salt'")
        .fetch_optional(pool)
        .await?;
    if let Some(stored) = stored {
        let salt = base64_decode(&stored).unwrap_or_default();
        if salt.len() != SALT_LENGTH {
            bail!(
                "Invalid salt length in database: expected {SALT_LENGTH} bytes, got {}. \
                 The database may be corrupted. Delete ~/.s3browser/s3browser.db to start fresh.",
                salt.len()
            );
        }
        return Ok(salt);
    }
    let salt: [u8; SALT_LENGTH] = random_bytes();
    sqlx::query("INSERT INTO metadata (key, value) VALUES ('encryption_salt', ?)")
        .bind(base64_encode(&salt))
        .execute(pool)
        .await?;
    Ok(salt.to_vec())
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct IndexedBucket {
    pub id: i64,
    pub last_completed_at: Option<i64>,
    pub object_count: Option<i64>,
}

/// One listed object for [`IndexDb::upsert_batch`].
#[derive(Clone, Debug)]
pub struct IndexRow {
    pub key: String,
    pub last_modified: i64,
    pub size: Option<i64>,
    pub content: Option<String>,
}

#[derive(Debug, Default, PartialEq)]
pub struct UpsertCounts {
    pub added: u64,
    pub updated: u64,
    pub touched: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SearchSort {
    Key,
    LastModified,
}

pub struct SearchParams<'a> {
    pub query: &'a str,
    pub limit: i64,
    pub offset: i64,
    pub sort: SearchSort,
    pub descending: bool,
    pub prefix: &'a str,
    pub extension: &'a str,
}

#[derive(Debug, sqlx::FromRow)]
pub struct SearchHit {
    pub key: String,
    pub last_modified: i64,
    pub size: Option<i64>,
    #[sqlx(rename = "contentSnippet")]
    pub content_snippet: Option<String>,
    #[sqlx(rename = "contentMatchCount")]
    pub content_match_count: i64,
}

const INDEX_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS s3_indexed_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_host TEXT NOT NULL,
  bucket TEXT NOT NULL,
  last_completed_at INTEGER,
  object_count INTEGER,
  UNIQUE(endpoint_host, bucket)
);

CREATE TABLE IF NOT EXISTS s3_object_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  indexed_bucket_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  last_modified INTEGER NOT NULL,
  size INTEGER,
  seen_at INTEGER NOT NULL,
  content TEXT,
  UNIQUE(indexed_bucket_id, key),
  FOREIGN KEY (indexed_bucket_id) REFERENCES s3_indexed_buckets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_s3_object_index_bucket ON s3_object_index(indexed_bucket_id);

CREATE VIRTUAL TABLE IF NOT EXISTS s3_object_content_fts USING fts5(
  content,
  content='s3_object_index',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS s3_object_index_ai AFTER INSERT ON s3_object_index BEGIN
  INSERT INTO s3_object_content_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS s3_object_index_ad AFTER DELETE ON s3_object_index BEGIN
  INSERT INTO s3_object_content_fts(s3_object_content_fts, rowid, content)
  VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS s3_object_index_au AFTER UPDATE OF content ON s3_object_index
WHEN old.content IS NOT new.content
BEGIN
  INSERT INTO s3_object_content_fts(s3_object_content_fts, rowid, content)
  VALUES('delete', old.id, old.content);
  INSERT INTO s3_object_content_fts(rowid, content) VALUES (new.id, new.content);
END;
";

/// Escape `\`, `%` and `_` for a `LIKE … ESCAPE '\'` pattern.
fn escape_like(value: &str) -> String {
    value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// The search index database.
#[derive(Clone)]
pub struct IndexDb {
    pool: SqlitePool,
}

impl IndexDb {
    pub async fn open(path: &Path) -> anyhow::Result<Self> {
        let pool = connect(path, INDEX_DB_BUSY_TIMEOUT).await?;
        sqlx::raw_sql(INDEX_SCHEMA)
            .execute(&pool)
            .await
            .context("failed to create the search index schema")?;
        Ok(Self { pool })
    }

    /// Delete the index database (and its WAL files) and recreate it empty.
    pub async fn reset(path: &Path) -> anyhow::Result<Self> {
        for suffix in ["", "-wal", "-shm"] {
            let file = path.with_file_name(format!(
                "{}{suffix}",
                path.file_name().context("index path has no file name")?.to_string_lossy()
            ));
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e).with_context(|| format!("failed to delete {}", file.display())),
            }
        }
        Self::open(path).await
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn get_or_create_bucket(&self, endpoint_host: &str, bucket: &str) -> sqlx::Result<i64> {
        sqlx::query(
            "INSERT INTO s3_indexed_buckets (endpoint_host, bucket) VALUES (?, ?)
             ON CONFLICT(endpoint_host, bucket) DO NOTHING",
        )
        .bind(endpoint_host)
        .bind(bucket)
        .execute(&self.pool)
        .await?;
        sqlx::query_scalar("SELECT id FROM s3_indexed_buckets WHERE endpoint_host = ? AND bucket = ?",
        )
        .bind(endpoint_host)
            .bind(bucket)
            .fetch_one(&self.pool)
            .await
    }

    pub async fn status(&self, endpoint_host: &str, bucket: &str) -> sqlx::Result<Option<IndexedBucket>> {
        sqlx::query_as(
            "SELECT id, last_completed_at, object_count FROM s3_indexed_buckets WHERE endpoint_host = ? AND bucket = ?",
        )
        .bind(endpoint_host)
        .bind(bucket)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn mark_completed(&self, indexed_bucket_id: i64, object_count: i64) -> sqlx::Result<()> {
        sqlx::query("UPDATE s3_indexed_buckets SET last_completed_at = unixepoch(), object_count = ? WHERE id = ?")
            .bind(object_count)
            .bind(indexed_bucket_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// `key → last_modified` for the given keys already in the index.
    pub async fn last_modified_by_key(&self, indexed_bucket_id: i64, keys: &[&str]) -> sqlx::Result<HashMap<String, i64>> {
        let mut result = HashMap::new();
        for chunk in keys.chunks(KEY_LOOKUP_CHUNK) {
            let mut query: QueryBuilder<Sqlite> =
                QueryBuilder::new("SELECT key, last_modified FROM s3_object_index WHERE indexed_bucket_id = ");
            query.push_bind(indexed_bucket_id).push(" AND key IN (");
            let mut separated = query.separated(", ");
            for key in chunk {
                separated.push_bind(*key);
            }
            query.push(")");
            for row in query.build().fetch_all(&self.pool).await? {
                result.insert(row.get("key"), row.get("last_modified"));
            }
        }
        Ok(result)
    }

    /// Insert or refresh one listing page. A row whose `last_modified` is
    /// unchanged keeps its stored size and content and only has `seen_at` bumped.
    pub async fn upsert_batch(&self, indexed_bucket_id: i64, seen_at: i64, rows: &[IndexRow]) -> sqlx::Result<UpsertCounts> {
        let mut counts = UpsertCounts::default();
        if rows.is_empty() {
            return Ok(counts);
        }
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        let existing = self.last_modified_by_key(indexed_bucket_id, &keys).await?;
        let mut tx = self.pool.begin().await?;
        for row in rows {
            match existing.get(&row.key) {
                None => counts.added += 1,
                Some(&prior) if prior == row.last_modified => counts.touched += 1,
                Some(_) => counts.updated += 1,
            }
            sqlx::query(
                "INSERT INTO s3_object_index (indexed_bucket_id, key, last_modified, size, seen_at, content)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(indexed_bucket_id, key) DO UPDATE SET
                   size = CASE WHEN s3_object_index.last_modified = excluded.last_modified
                               THEN s3_object_index.size ELSE excluded.size END,
                   content = CASE WHEN s3_object_index.last_modified = excluded.last_modified
                                  THEN s3_object_index.content ELSE excluded.content END,
                   last_modified = excluded.last_modified,
                   seen_at = excluded.seen_at",
            )
            .bind(indexed_bucket_id)
            .bind(&row.key)
            .bind(row.last_modified)
            .bind(row.size)
            .bind(seen_at)
            .bind(&row.content)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(counts)
    }

    /// The `seen_at` stamp for a new run: now, but always past every stamp a
    /// previous run left, or a rerun within the same second (or after the
    /// clock stepped back) would sweep nothing.
    pub async fn next_run_stamp(&self, indexed_bucket_id: i64, now: i64) -> sqlx::Result<i64> {
        let latest: Option<i64> = sqlx::query_scalar("SELECT MAX(seen_at) FROM s3_object_index WHERE indexed_bucket_id = ?")
            .bind(indexed_bucket_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(latest.map_or(now, |latest| now.max(latest + 1)))
    }

    /// Delete rows not seen since `run_started_at`: objects gone from the bucket.
    pub async fn sweep_stale(&self, indexed_bucket_id: i64, run_started_at: i64) -> sqlx::Result<u64> {
        let result = sqlx::query("DELETE FROM s3_object_index WHERE indexed_bucket_id = ? AND seen_at < ?")
            .bind(indexed_bucket_id)
            .bind(run_started_at)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// Substring search over keys and indexed content: one page of hits plus
    /// the total match count.
    pub async fn search(&self, indexed_bucket_id: i64, params: &SearchParams<'_>) -> sqlx::Result<(Vec<SearchHit>, i64)> {
        let like = format!("%{}%", escape_like(params.query));
        let push_where = |query: &mut QueryBuilder<Sqlite>| {
            query.push(" WHERE indexed_bucket_id = ").push_bind(indexed_bucket_id);
            query
                .push(" AND (key LIKE ")
                .push_bind(like.clone())
                .push(" ESCAPE '\\' OR id IN (SELECT rowid FROM s3_object_content_fts WHERE content LIKE ")
                .push_bind(like.clone())
                .push(" ESCAPE '\\'))");
            if !params.prefix.is_empty() {
                query
                    .push(" AND key LIKE ")
                    .push_bind(format!("{}%", escape_like(params.prefix)))
                    .push(" ESCAPE '\\'");
            }
            if !params.extension.is_empty() {
                query
                    .push(" AND key LIKE ")
                    .push_bind(format!("%.{}", escape_like(params.extension)))
                    .push(" ESCAPE '\\'");
            }
        };

        let mut select: QueryBuilder<Sqlite> = QueryBuilder::new("SELECT key, last_modified, size, CASE WHEN content IS NOT NULL AND INSTR(LOWER(content), LOWER(");
        select
            .push_bind(params.query)
            .push(")) > 0 THEN SUBSTR(content, MAX(1, INSTR(LOWER(content), LOWER(")
            .push_bind(params.query)
            .push(")) - 30), LENGTH(")
            .push_bind(params.query)
            .push(") + 60) ELSE NULL END AS contentSnippet, CASE WHEN content IS NOT NULL AND INSTR(LOWER(content), LOWER(")
            .push_bind(params.query)
            .push(")) > 0 THEN (LENGTH(LOWER(content)) - LENGTH(REPLACE(LOWER(content), LOWER(")
            .push_bind(params.query)
            .push("), ''))) / LENGTH(")
            .push_bind(params.query)
            .push(") ELSE 0 END AS contentMatchCount FROM s3_object_index");
        push_where(&mut select);
        let direction = if params.descending { "DESC" } else { "ASC" };
        match params.sort {
            SearchSort::LastModified => select.push(format!(" ORDER BY last_modified {direction}, key ASC")),
            SearchSort::Key => select.push(format!(" ORDER BY key {direction}")),
        };
        select.push(" LIMIT ").push_bind(params.limit).push(" OFFSET ").push_bind(params.offset);
        let hits = select.build_query_as::<SearchHit>().fetch_all(&self.pool).await?;

        let mut count: QueryBuilder<Sqlite> = QueryBuilder::new("SELECT COUNT(*) FROM s3_object_index");
        push_where(&mut count);
        let total: i64 = count.build_query_scalar().fetch_one(&self.pool).await?;
        Ok((hits, total))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn save<'a>(name: &'a str, secret: Option<&'a str>) -> SaveConnection<'a> {
        SaveConnection {
            id: None,
            profile_name: name,
            endpoint: "http://127.0.0.1:9000",
            access_key_id: "AK",
            secret_access_key: secret,
            bucket: Some("b"),
            region: Some("us-east-1"),
            auto_detect_region: true,
        }
    }

    #[tokio::test]
    async fn connections_round_trip_with_encrypted_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s3browser.db");
        let db = Db::open(&path, KEY).await.unwrap();

        let saved = db.save_connection(save("prod", Some("s3cret"))).await.unwrap();
        assert_ne!(saved.secret_access_key, "s3cret");
        assert_eq!(db.decrypt_secret(&saved).unwrap(), "s3cret");
        assert!(matches!(
            db.save_connection(save("prod", Some("x"))).await,
            Err(SaveError::DuplicateProfile)
        ));

        // Updating without a secret keeps the stored one.
        let updated = db
            .save_connection(SaveConnection {
                id: Some(saved.id),
                bucket: None,
                auto_detect_region: false,
                ..save("renamed", None)
            })
            .await
            .unwrap();
        assert_eq!((updated.profile_name.as_str(), updated.bucket.as_deref()), ("renamed", None));
        assert!(!updated.auto_detect_region);
        assert_eq!(db.decrypt_secret(&updated).unwrap(), "s3cret");
        assert!(matches!(
            db.save_connection(SaveConnection { id: Some(999), ..save("x", None) }).await,
            Err(SaveError::NotFound)
        ));

        assert_eq!(db.connections().await.unwrap().len(), 1);
        assert!(db.delete_connection(saved.id).await.unwrap());
        assert!(!db.delete_connection(saved.id).await.unwrap());
        db.close().await;
    }

    #[tokio::test]
    async fn touch_keeps_the_most_recent_buckets_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("s3browser.db"), KEY).await.unwrap();
        let saved = db.save_connection(save("prod", Some("s3cret"))).await.unwrap();
        let other = db.save_connection(save("other", Some("s3cret"))).await.unwrap();

        // Touching without a bucket records nothing.
        db.touch(saved.id, None, 1).await.unwrap();
        assert!(db.recent_buckets_for(saved.id).await.unwrap().is_empty());

        for i in 1..=(RECENT_BUCKETS_LIMIT + 1) {
            db.touch(saved.id, Some(&format!("b{i}")), 1_000 + i).await.unwrap();
        }
        db.touch(other.id, Some("elsewhere"), 5_000).await.unwrap();
        let names = |rows: Vec<RecentBucket>| rows.into_iter().map(|r| r.bucket).collect::<Vec<_>>();

        let recent = db.recent_buckets_for(saved.id).await.unwrap();
        assert_eq!(recent.len() as i64, RECENT_BUCKETS_LIMIT);
        assert_eq!(recent[0], RecentBucket { connection_id: saved.id, bucket: "b9".into(), last_used_at: 1_009 });
        assert!(!names(recent.clone()).contains(&"b1".to_string()), "oldest bucket is pruned");

        // Re-opening a bucket moves it to the front without adding a row.
        db.touch(saved.id, Some("b2"), 9_000).await.unwrap();
        let recent = names(db.recent_buckets_for(saved.id).await.unwrap());
        assert_eq!(recent.len() as i64, RECENT_BUCKETS_LIMIT);
        assert_eq!(&recent[..2], ["b2", "b9"]);

        let all = db.recent_buckets().await.unwrap();
        assert_eq!(all.len() as i64, RECENT_BUCKETS_LIMIT + 1);
        assert!(all.iter().any(|r| r.connection_id == other.id && r.bucket == "elsewhere"));

        // Deleting the connection drops its recent buckets.
        assert!(db.delete_connection(saved.id).await.unwrap());
        assert!(db.recent_buckets_for(saved.id).await.unwrap().is_empty());
        assert_eq!(names(db.recent_buckets().await.unwrap()), ["elsewhere"]);
        db.close().await;
    }

    #[tokio::test]
    async fn reopening_with_another_key_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s3browser.db");
        let db = Db::open(&path, KEY).await.unwrap();
        db.save_connection(save("prod", Some("s3cret"))).await.unwrap();
        db.close().await;

        let error = Db::open(&path, &"z".repeat(32)).await.err().unwrap().to_string();
        assert!(error.starts_with("Encryption key mismatch"), "{error}");
        let db = Db::open(&path, KEY).await.unwrap();
        assert_eq!(db.connections().await.unwrap().len(), 1);
    }

    fn row(key: &str, last_modified: i64, content: Option<&str>) -> IndexRow {
        IndexRow {
            key: key.to_string(),
            last_modified,
            size: Some(10),
            content: content.map(str::to_string),
        }
    }

    fn params(query: &str) -> SearchParams<'_> {
        SearchParams {
            query,
            limit: 100,
            offset: 0,
            sort: SearchSort::Key,
            descending: false,
            prefix: "",
            extension: "",
        }
    }

    #[tokio::test]
    async fn index_upserts_sweeps_and_searches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.db");
        let index = IndexDb::open(&path).await.unwrap();
        let bucket = index.get_or_create_bucket("host", "b").await.unwrap();
        assert_eq!(index.get_or_create_bucket("host", "b").await.unwrap(), bucket);

        let counts = index
            .upsert_batch(
                bucket,
                100,
                &[
                    row("docs/readme.md", 1, Some("Hello World, hello again")),
                    row("docs/notes_1.txt", 2, Some("nothing here")),
                    row("img/photo.jpg", 3, None),
                ],
            )
            .await
            .unwrap();
        assert_eq!(counts, UpsertCounts { added: 3, updated: 0, touched: 0 });
        assert_eq!(index.next_run_stamp(bucket, 100).await.unwrap(), 101);
        assert_eq!(index.next_run_stamp(bucket, 200).await.unwrap(), 200);

        let (hits, total) = index.search(bucket, &params("hello")).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(hits[0].key, "docs/readme.md");
        assert_eq!(hits[0].content_match_count, 2);
        assert_eq!(hits[0].content_snippet.as_deref(), Some("Hello World, hello again"));

        // `_` is literal, not a wildcard; key matches have no snippet.
        let (hits, _) = index.search(bucket, &params("notes_")).await.unwrap();
        assert_eq!(hits.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(), ["docs/notes_1.txt"]);
        assert_eq!(hits[0].content_snippet, None);
        let (_, total) = index.search(bucket, &params("notesx")).await.unwrap();
        assert_eq!(total, 0);

        let (hits, total) = index
            .search(
                bucket,
                &SearchParams {
                    sort: SearchSort::LastModified,
                    descending: true,
                    extension: "jpg",
                    prefix: "img/",
                    ..params("o")
                },
            )
            .await
            .unwrap();
        assert_eq!((total, hits[0].key.as_str()), (1, "img/photo.jpg"));

        // Second run: one unchanged, one modified (new content), one gone.
        let counts = index
            .upsert_batch(
                bucket,
                200,
                &[row("docs/readme.md", 1, None), row("docs/notes_1.txt", 5, Some("now says hello"))],
            )
            .await
            .unwrap();
        assert_eq!(counts, UpsertCounts { added: 0, updated: 1, touched: 1 });
        assert_eq!(index.sweep_stale(bucket, 200).await.unwrap(), 1);
        let (hits, _) = index.search(bucket, &params("hello")).await.unwrap();
        assert_eq!(
            hits.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(),
            ["docs/notes_1.txt", "docs/readme.md"],
            "unchanged rows keep their content; changed rows get the new one"
        );

        index.mark_completed(bucket, 2).await.unwrap();
        let status = index.status("host", "b").await.unwrap().unwrap();
        assert_eq!(status.object_count, Some(2));
        assert!(status.last_completed_at.is_some());

        index.close().await;
        let index = IndexDb::reset(&path).await.unwrap();
        assert!(index.status("host", "b").await.unwrap().is_none());
    }
}
