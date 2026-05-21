from __future__ import annotations

import base64
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from s3browser.config import validate_encryption_key_source, validate_login_password
from s3browser.crypto import decrypt, encrypt, generate_salt, set_salt, validate_encryption_key
from s3browser.paths import DB_PATH, INDEX_DB_PATH, ensure_app_dir

KEY_CHECK_CANARY = "s3browser-key-check-v1"
DEFAULT_DB_BUSY_TIMEOUT_MS = 5000
INDEX_DB_BUSY_TIMEOUT_MS = 30000

_db: sqlite3.Connection | None = None
_index_db: sqlite3.Connection | None = None


@dataclass(frozen=True)
class S3Connection:
    id: int
    profile_name: str
    endpoint: str
    access_key_id: str
    secret_access_key: str
    bucket: str | None
    region: str | None
    auto_detect_region: int
    last_used_at: int


@dataclass(frozen=True)
class IndexedBucket:
    id: int
    endpoint_host: str
    bucket: str
    last_completed_at: int | None
    object_count: int | None


def _row_to_connection(row: sqlite3.Row | None) -> S3Connection | None:
    if row is None:
        return None
    return S3Connection(
        id=int(row["id"]),
        profile_name=str(row["profile_name"]),
        endpoint=str(row["endpoint"]),
        access_key_id=str(row["access_key_id"]),
        secret_access_key=str(row["secret_access_key"]),
        bucket=row["bucket"],
        region=row["region"],
        auto_detect_region=int(row["auto_detect_region"]),
        last_used_at=int(row["last_used_at"]),
    )


def _row_to_indexed_bucket(row: sqlite3.Row | None) -> IndexedBucket | None:
    if row is None:
        return None
    return IndexedBucket(
        id=int(row["id"]),
        endpoint_host=str(row["endpoint_host"]),
        bucket=str(row["bucket"]),
        last_completed_at=row["last_completed_at"],
        object_count=row["object_count"],
    )


def _connect(path: Path, busy_timeout_ms: int) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _initialize_salt(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
        """
    )
    row = conn.execute("SELECT value FROM metadata WHERE key = 'encryption_salt'").fetchone()
    if row:
        salt = base64.b64decode(str(row["value"]))
        if len(salt) != 32:
            raise RuntimeError(
                f"Invalid salt length in database: expected 32 bytes, got {len(salt)}. "
                "The database may be corrupted. Delete ~/.s3browser/s3browser.db to start fresh."
            )
    else:
        salt = generate_salt()
        conn.execute(
            "INSERT INTO metadata (key, value) VALUES ('encryption_salt', ?)",
            (base64.b64encode(salt).decode("ascii"),),
        )
        conn.commit()
    set_salt(salt)


def _verify_encryption_key(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT value FROM metadata WHERE key = 'key_check'").fetchone()
    if row is None:
        table_row = conn.execute(
            """
            SELECT COUNT(*) AS count FROM sqlite_master
            WHERE type = 'table' AND name = 's3_connections'
            """
        ).fetchone()
        if table_row and int(table_row["count"]) > 0:
            count_row = conn.execute(
                "SELECT COUNT(*) AS count FROM s3_connections WHERE secret_access_key IS NOT NULL"
            ).fetchone()
            if count_row and int(count_row["count"]) > 0:
                raise RuntimeError(
                    "Encryption key verification failed: key_check is missing, but encrypted "
                    "connections exist. Use the original encryption key, or delete "
                    "~/.s3browser/s3browser.db to start fresh."
                )
        conn.execute(
            "INSERT INTO metadata (key, value) VALUES ('key_check', ?)",
            (encrypt(KEY_CHECK_CANARY),),
        )
        conn.commit()
        return
    try:
        if decrypt(str(row["value"])) != KEY_CHECK_CANARY:
            raise RuntimeError("Decrypted value does not match expected canary")
    except Exception as error:
        raise RuntimeError(
            "Encryption key mismatch: The current encryption key does not match the one used "
            "to initialize the database. Use the original key, or delete "
            "~/.s3browser/s3browser.db to start fresh."
        ) from error


def _initialize_database() -> sqlite3.Connection:
    ensure_app_dir()
    conn = _connect(DB_PATH, DEFAULT_DB_BUSY_TIMEOUT_MS)
    _initialize_salt(conn)
    validate_encryption_key_source()
    validate_encryption_key()
    validate_login_password()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS s3_connections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_name TEXT NOT NULL UNIQUE,
          endpoint TEXT NOT NULL,
          access_key_id TEXT NOT NULL,
          secret_access_key TEXT NOT NULL,
          bucket TEXT,
          region TEXT,
          auto_detect_region INTEGER DEFAULT 1,
          last_used_at INTEGER DEFAULT (unixepoch())
        )
        """
    )
    conn.commit()
    _verify_encryption_key(conn)
    return conn


def _initialize_index_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
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
                    INSERT INTO s3_object_content_fts(rowid, content)
                    VALUES (new.id, new.content);
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
        """
    )
    conn.commit()


def _initialize_index_database() -> sqlite3.Connection:
    ensure_app_dir()
    conn = _connect(INDEX_DB_PATH, INDEX_DB_BUSY_TIMEOUT_MS)
    _initialize_index_schema(conn)
    return conn


def get_db() -> sqlite3.Connection:
    global _db
    if _db is None:
        _db = _initialize_database()
    return _db


def get_index_db() -> sqlite3.Connection:
    global _index_db
    if _index_db is None:
        _index_db = _initialize_index_database()
    return _index_db


def close_db() -> None:
    global _db, _index_db
    if _db is not None:
        _db.close()
        _db = None
    if _index_db is not None:
        _index_db.close()
        _index_db = None


def get_all_connections() -> list[S3Connection]:
    rows = get_db().execute("SELECT * FROM s3_connections ORDER BY last_used_at DESC").fetchall()
    return [conn for row in rows if (conn := _row_to_connection(row)) is not None]


def get_connection_by_id(connection_id: int) -> S3Connection | None:
    row = get_db().execute("SELECT * FROM s3_connections WHERE id = ?", (connection_id,)).fetchone()
    return _row_to_connection(row)


def save_connection(
    connection_id: int | None,
    profile_name: str,
    endpoint: str,
    access_key_id: str,
    secret_access_key: str | None,
    bucket: str | None,
    region: str | None,
    auto_detect_region: bool,
) -> S3Connection:
    conn = get_db()
    if connection_id is not None:
        if secret_access_key:
            conn.execute(
                """
                UPDATE s3_connections SET
                  profile_name = ?, endpoint = ?, access_key_id = ?, secret_access_key = ?,
                  bucket = ?, region = ?, auto_detect_region = ?, last_used_at = unixepoch()
                WHERE id = ?
                """,
                (
                    profile_name,
                    endpoint,
                    access_key_id,
                    encrypt(secret_access_key),
                    bucket,
                    region,
                    1 if auto_detect_region else 0,
                    connection_id,
                ),
            )
        else:
            conn.execute(
                """
                UPDATE s3_connections SET
                  profile_name = ?, endpoint = ?, access_key_id = ?, bucket = ?, region = ?,
                  auto_detect_region = ?, last_used_at = unixepoch()
                WHERE id = ?
                """,
                (
                    profile_name,
                    endpoint,
                    access_key_id,
                    bucket,
                    region,
                    1 if auto_detect_region else 0,
                    connection_id,
                ),
            )
        if conn.total_changes == 0:
            raise RuntimeError("Connection not found")
        conn.commit()
        saved = get_connection_by_id(connection_id)
        if saved is None:
            raise RuntimeError("Connection not found")
        return saved
    if not secret_access_key:
        raise RuntimeError("Secret access key is required for new connections")
    cursor = conn.execute(
        """
        INSERT INTO s3_connections
          (profile_name, endpoint, access_key_id, secret_access_key, bucket, region,
           auto_detect_region, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        """,
        (
            profile_name,
            endpoint,
            access_key_id,
            encrypt(secret_access_key),
            bucket,
            region,
            1 if auto_detect_region else 0,
        ),
    )
    conn.commit()
    if cursor.lastrowid is None:
        raise RuntimeError("Failed to save connection")
    saved = get_connection_by_id(int(cursor.lastrowid))
    if saved is None:
        raise RuntimeError("Failed to load saved connection")
    return saved


def delete_connection_by_id(connection_id: int) -> bool:
    cursor = get_db().execute("DELETE FROM s3_connections WHERE id = ?", (connection_id,))
    get_db().commit()
    return cursor.rowcount > 0


def update_connection_last_used(connection_id: int) -> bool:
    cursor = get_db().execute(
        "UPDATE s3_connections SET last_used_at = unixepoch() WHERE id = ?",
        (connection_id,),
    )
    get_db().commit()
    return cursor.rowcount > 0


def decrypt_connection_secret_key(connection: S3Connection) -> str:
    return decrypt(connection.secret_access_key)


def is_unique_constraint_error(error: Exception) -> bool:
    return isinstance(error, sqlite3.IntegrityError) and "UNIQUE constraint failed" in str(error)


def delete_index_database() -> None:
    global _index_db
    if _index_db is not None:
        _index_db.close()
        _index_db = None
    for path in (INDEX_DB_PATH, Path(f"{INDEX_DB_PATH}-wal"), Path(f"{INDEX_DB_PATH}-shm")):
        if path.exists():
            path.unlink()
    get_index_db()


def get_or_create_indexed_bucket(endpoint_host: str, bucket: str) -> int:
    conn = get_index_db()
    conn.execute(
        """
        INSERT INTO s3_indexed_buckets (endpoint_host, bucket)
        VALUES (?, ?)
        ON CONFLICT(endpoint_host, bucket) DO NOTHING
        """,
        (endpoint_host, bucket),
    )
    conn.commit()
    row = conn.execute(
        "SELECT id FROM s3_indexed_buckets WHERE endpoint_host = ? AND bucket = ?",
        (endpoint_host, bucket),
    ).fetchone()
    if row is None:
        raise RuntimeError("Failed to create indexed bucket row")
    return int(row["id"])


def get_index_status(endpoint_host: str, bucket: str) -> IndexedBucket | None:
    row = (
        get_index_db()
        .execute(
            "SELECT * FROM s3_indexed_buckets WHERE endpoint_host = ? AND bucket = ?",
            (endpoint_host, bucket),
        )
        .fetchone()
    )
    return _row_to_indexed_bucket(row)


def mark_index_completed(indexed_bucket_id: int, object_count: int) -> None:
    get_index_db().execute(
        """
        UPDATE s3_indexed_buckets
        SET last_completed_at = unixepoch(), object_count = ?
        WHERE id = ?
        """,
        (object_count, indexed_bucket_id),
    )
    get_index_db().commit()


def find_object_index_rows_by_keys(indexed_bucket_id: int, keys: list[str]) -> dict[str, int]:
    if not keys:
        return {}
    result: dict[str, int] = {}
    for key in keys:
        row = (
            get_index_db()
            .execute(
                """
            SELECT key, last_modified FROM s3_object_index
            WHERE indexed_bucket_id = ? AND key = ?
            """,
                (indexed_bucket_id, key),
            )
            .fetchone()
        )
        if row:
            result[str(row["key"])] = int(row["last_modified"])
    return result


def upsert_object_index_batch(
    indexed_bucket_id: int, seen_at: int, rows: list[dict[str, Any]]
) -> dict[str, int]:
    conn = get_index_db()
    result = {"added": 0, "updated": 0, "touched": 0}
    for row in rows:
        existing = conn.execute(
            """
            SELECT id, last_modified FROM s3_object_index
            WHERE indexed_bucket_id = ? AND key = ?
            """,
            (indexed_bucket_id, row["key"]),
        ).fetchone()
        if existing is None:
            conn.execute(
                """
                                INSERT INTO s3_object_index
                                    (indexed_bucket_id, key, last_modified, size, seen_at, content)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    indexed_bucket_id,
                    row["key"],
                    row["last_modified"],
                    row["size"],
                    seen_at,
                    row["content"],
                ),
            )
            result["added"] += 1
        elif int(existing["last_modified"]) == int(row["last_modified"]):
            conn.execute(
                "UPDATE s3_object_index SET seen_at = ? WHERE id = ?", (seen_at, existing["id"])
            )
            result["touched"] += 1
        else:
            conn.execute(
                """
                UPDATE s3_object_index
                SET last_modified = ?, size = ?, seen_at = ?, content = ?
                WHERE id = ?
                """,
                (row["last_modified"], row["size"], seen_at, row["content"], existing["id"]),
            )
            result["updated"] += 1
    conn.commit()
    return result


def sweep_stale_objects(indexed_bucket_id: int, run_started_at: int) -> int:
    cursor = get_index_db().execute(
        "DELETE FROM s3_object_index WHERE indexed_bucket_id = ? AND seen_at < ?",
        (indexed_bucket_id, run_started_at),
    )
    get_index_db().commit()
    return cursor.rowcount


def escape_like_pattern(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def search_object_index(
    indexed_bucket_id: int,
    query: str,
    *,
    limit: int,
    offset: int,
    sort: str = "key",
    direction: str = "asc",
    prefix: str = "",
) -> dict[str, Any]:
    conn = get_index_db()
    like_pattern = f"%{escape_like_pattern(query)}%"
    where_parts = [
        "indexed_bucket_id = ?",
        """
        (
          key LIKE ? ESCAPE '\\'
          OR id IN (SELECT rowid FROM s3_object_content_fts WHERE content LIKE ? ESCAPE '\\')
        )
        """,
    ]
    params: list[Any] = [indexed_bucket_id, like_pattern, like_pattern]
    if prefix:
        where_parts.append("key LIKE ? ESCAPE '\\'")
        params.append(f"{escape_like_pattern(prefix)}%")
    where_sql = " AND ".join(where_parts)
    sort_key = "last_modified" if sort == "last_modified" else "key"
    sort_dir = "desc" if direction == "desc" else "asc"
    order_sql = (
        f"last_modified {sort_dir}, key ASC" if sort_key == "last_modified" else f"key {sort_dir}"
    )
    snippet_sql = """
      CASE
        WHEN content IS NOT NULL AND INSTR(LOWER(content), LOWER(?)) > 0 THEN
          SUBSTR(content, MAX(1, INSTR(LOWER(content), LOWER(?)) - 30), LENGTH(?) + 60)
        ELSE NULL
      END AS contentSnippet,
      CASE
        WHEN content IS NOT NULL AND INSTR(LOWER(content), LOWER(?)) > 0 THEN
          (LENGTH(LOWER(content)) - LENGTH(REPLACE(LOWER(content), LOWER(?), ''))) / LENGTH(?)
        ELSE 0
      END AS contentMatchCount
    """
    rows = conn.execute(
        f"""
        SELECT key, last_modified, size, {snippet_sql}
        FROM s3_object_index
        WHERE {where_sql}
        ORDER BY {order_sql}
        LIMIT ? OFFSET ?
        """,
        [query, query, query, query, query, query, *params, limit, offset],
    ).fetchall()
    total_row = conn.execute(
        f"SELECT COUNT(*) AS count FROM s3_object_index WHERE {where_sql}",
        params,
    ).fetchone()
    return {
        "hits": [dict(row) for row in rows],
        "total": int(total_row["count"]) if total_row else 0,
    }


def now_seconds() -> int:
    return int(time.time())
