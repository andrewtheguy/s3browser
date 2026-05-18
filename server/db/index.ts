import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { validateEncryptionKey, validateLoginPassword, encrypt, decrypt, setSalt, generateSalt, getSaltLength } from './crypto.js';

// Database directory and file paths. The connection/credentials DB is kept
// separate from the search-index DB so the index can be wiped (--reset)
// without touching saved connections.
const DB_DIR = join(homedir(), '.s3browser');
const DB_PATH = join(DB_DIR, 's3browser.db');
const INDEX_DB_PATH = join(DB_DIR, 's3browser-index.db');
const DEFAULT_DB_BUSY_TIMEOUT_MS = 5000;
const INDEX_DB_BUSY_TIMEOUT_MS = 30000;

let db: Database | null = null;
let indexDb: Database | null = null;

export interface DbS3Connection {
  id: number;
  profile_name: string;
  endpoint: string;
  access_key_id: string;
  secret_access_key: string;
  bucket: string | null;
  region: string | null;
  auto_detect_region: number;
  last_used_at: number;
}

export interface DbIndexedBucket {
  id: number;
  endpoint_host: string;
  bucket: string;
  /** Unix epoch seconds when the most recent crawl finished; null until first completion. */
  last_completed_at: number | null;
  object_count: number | null;
}

export interface DbObjectIndexRow {
  id: number;
  indexed_bucket_id: number;
  key: string;
  /** Unix epoch seconds, from S3 LastModified. */
  last_modified: number;
  size: number | null;
  /** Unix epoch seconds; set to the run's start time each time the indexer touches this row. */
  seen_at: number;
}

// Canary value used to verify encryption key consistency
const KEY_CHECK_CANARY = 's3browser-key-check-v1';

function verifyEncryptionKey(database: Database): void {
  // Metadata table is created by initializeSalt before this function is called
  const row = database.prepare(`SELECT value FROM metadata WHERE key = 'key_check'`).get() as { value: string } | undefined;

  if (!row) {
    // No key_check yet - check if there's existing encrypted data that could indicate a key/salt mismatch
    const connectionCount = database.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type='table' AND name='s3_connections'
    `).get() as { count: number };

    if (connectionCount.count > 0) {
      const existingConnections = database.prepare(`
        SELECT COUNT(*) as count FROM s3_connections WHERE secret_access_key IS NOT NULL
      `).get() as { count: number };

      if (existingConnections.count > 0) {
        throw new Error(
          'Encryption key verification failed: key_check is missing, ' +
          `but ${existingConnections.count} connection(s) with encrypted data exist in s3_connections table.\n` +
          'This may indicate the encryption key or salt has changed, or the database is in an inconsistent state.\n' +
          'To fix this, use the original encryption key, or delete ~/.s3browser/s3browser.db to start fresh ' +
          '(this will delete all saved connections).'
        );
      }
    }

    // No existing encrypted data found, safe to store the canary for future checks
    const encryptedCanary = encrypt(KEY_CHECK_CANARY);
    database.prepare(`INSERT INTO metadata (key, value) VALUES ('key_check', ?)`).run(encryptedCanary);
    return;
  }

  // Try to decrypt and verify the canary
  try {
    const decrypted = decrypt(row.value);
    if (decrypted !== KEY_CHECK_CANARY) {
      throw new Error('Decrypted value does not match expected canary');
    }
  } catch {
    throw new Error(
      'Encryption key mismatch: The current encryption key does not match the one used to initialize the database.\n' +
      'This can happen if:\n' +
      '  - The S3BROWSER_ENCRYPTION_KEY environment variable changed\n' +
      '  - The ~/.s3browser/encryption.key file was modified\n' +
      '  - You are using a different key file or environment\n\n' +
      'To fix this, use the original encryption key, or delete ~/.s3browser/s3browser.db to start fresh (this will delete all saved connections).'
    );
  }
}

function initializeSalt(database: Database): void {
  // Ensure metadata table exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Check for existing salt
  const row = database.prepare(`SELECT value FROM metadata WHERE key = 'encryption_salt'`).get() as { value: string } | undefined;

  if (row) {
    // Use existing salt
    const salt = Buffer.from(row.value, 'base64');
    if (salt.length !== getSaltLength()) {
      throw new Error(
        `Invalid salt length in database: expected ${getSaltLength()} bytes, got ${salt.length}. ` +
        'The database may be corrupted. Delete ~/.s3browser/s3browser.db to start fresh.'
      );
    }
    setSalt(salt);
  } else {
    // Generate and store new salt
    const salt = generateSalt();
    database.prepare(`INSERT INTO metadata (key, value) VALUES ('encryption_salt', ?)`).run(salt.toString('base64'));
    setSalt(salt);
  }
}

function initializeObjectIndexSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS s3_indexed_buckets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_host TEXT NOT NULL,              -- normalized endpoint host (getEffectiveEndpointHost)
      bucket TEXT NOT NULL,
      last_completed_at INTEGER,                -- unix epoch seconds; NULL until first crawl completes
      object_count INTEGER,
      UNIQUE(endpoint_host, bucket)
    );

    CREATE TABLE IF NOT EXISTS s3_object_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indexed_bucket_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      last_modified INTEGER NOT NULL,           -- unix epoch seconds, from S3 LastModified
      size INTEGER,
      seen_at INTEGER NOT NULL,                 -- unix epoch seconds; updated each indexer run
      content TEXT,                             -- UTF-8 body for text-like objects (NULL if not indexed)
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
      INSERT INTO s3_object_content_fts(s3_object_content_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS s3_object_index_au AFTER UPDATE OF content ON s3_object_index
    WHEN old.content IS NOT new.content
    BEGIN
      INSERT INTO s3_object_content_fts(s3_object_content_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO s3_object_content_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
}

function initializeDatabase(): Database {
  // Ensure the database directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  // Open database
  const database = new Database(DB_PATH);
  database.exec(`PRAGMA busy_timeout = ${DEFAULT_DB_BUSY_TIMEOUT_MS}`);

  // Enable WAL mode for better concurrency
  database.exec('PRAGMA journal_mode = WAL');

  // Initialize salt from database (must happen before encryption key validation)
  initializeSalt(database);

  // Now validate encryption key (which requires salt to be set)
  validateEncryptionKey();

  // Fail fast at startup if the login password is missing/too short, rather than
  // letting the server boot and only error on the first login attempt.
  validateLoginPassword();

  // Create tables
  database.exec(`
    -- S3 connections: saved S3 connection profiles (globally unique profile names)
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
    );
  `);

  // Verify encryption key matches what was used to initialize the database
  verifyEncryptionKey(database);

  return database;
}

// The search-index tables live in their own SQLite file so they can be
// wiped wholesale (--reset) without affecting saved connections, and so
// the FTS5 virtual table doesn't share a page cache with credential data.
// All timestamp columns (last_completed_at, last_modified, seen_at) are
// unix epoch SECONDS (matching SQLite's unixepoch() function).
function initializeIndexDatabase(): Database {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }
  const database = new Database(INDEX_DB_PATH);
  database.exec(`PRAGMA busy_timeout = ${INDEX_DB_BUSY_TIMEOUT_MS}`);
  database.exec('PRAGMA journal_mode = WAL');
  initializeObjectIndexSchema(database);
  return database;
}

export function getDb(): Database {
  if (!db) {
    db = initializeDatabase();
  }
  return db;
}

export function getIndexDb(): Database {
  if (!indexDb) {
    indexDb = initializeIndexDatabase();
  }
  return indexDb;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  if (indexDb) {
    indexDb.close();
    indexDb = null;
  }
}

// S3 Connections operations
export function getAllConnections(): DbS3Connection[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM s3_connections
    ORDER BY last_used_at DESC
  `);
  return stmt.all() as DbS3Connection[];
}

export function getConnectionById(connectionId: number): DbS3Connection | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM s3_connections
    WHERE id = ?
  `);
  return stmt.get(connectionId) as DbS3Connection | undefined;
}

export function saveConnection(
  connectionId: number | null,
  profileName: string,
  endpoint: string,
  accessKeyId: string,
  secretAccessKey: string | null,
  bucket: string | null,
  region: string | null,
  autoDetectRegion: boolean
): DbS3Connection {
  const database = getDb();

  if (connectionId !== null) {
    // UPDATE existing connection by ID
    let result;
    if (secretAccessKey) {
      // Update with new secret key
      const encryptedSecretAccessKey = encrypt(secretAccessKey);
      const stmt = database.prepare(`
        UPDATE s3_connections SET
          profile_name = ?,
          endpoint = ?,
          access_key_id = ?,
          secret_access_key = ?,
          bucket = ?,
          region = ?,
          auto_detect_region = ?,
          last_used_at = unixepoch()
        WHERE id = ?
      `);
      result = stmt.run(profileName, endpoint, accessKeyId, encryptedSecretAccessKey, bucket, region, autoDetectRegion ? 1 : 0, connectionId);
    } else {
      // Update without changing the secret key
      const stmt = database.prepare(`
        UPDATE s3_connections SET
          profile_name = ?,
          endpoint = ?,
          access_key_id = ?,
          bucket = ?,
          region = ?,
          auto_detect_region = ?,
          last_used_at = unixepoch()
        WHERE id = ?
      `);
      result = stmt.run(profileName, endpoint, accessKeyId, bucket, region, autoDetectRegion ? 1 : 0, connectionId);
    }
    // Check that the update affected a row (avoids TOCTOU race condition)
    if (result.changes === 0) {
      throw new Error('Connection not found');
    }
    return getConnectionById(connectionId)!;
  } else {
    // INSERT new connection (profile_name uniqueness enforced by DB UNIQUE constraint)
    if (!secretAccessKey) {
      throw new Error('Secret access key is required for new connections');
    }
    const encryptedSecretAccessKey = encrypt(secretAccessKey);
    const stmt = database.prepare(`
      INSERT INTO s3_connections (profile_name, endpoint, access_key_id, secret_access_key, bucket, region, auto_detect_region, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    `);
    const result = stmt.run(profileName, endpoint, accessKeyId, encryptedSecretAccessKey, bucket, region, autoDetectRegion ? 1 : 0);
    return getConnectionById(Number(result.lastInsertRowid))!;
  }
}

export function deleteConnectionById(connectionId: number): boolean {
  const database = getDb();
  const stmt = database.prepare('DELETE FROM s3_connections WHERE id = ?');
  const result = stmt.run(connectionId);
  return result.changes > 0;
}

export function updateConnectionLastUsed(connectionId: number): boolean {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE s3_connections SET last_used_at = unixepoch() WHERE id = ?
  `);
  const result = stmt.run(connectionId);
  return result.changes > 0;
}

export function decryptConnectionSecretKey(connection: DbS3Connection): string {
  return decrypt(connection.secret_access_key);
}

/**
 * Check if an error is a SQLite UNIQUE constraint violation.
 * This is SQLite-specific and relies on the error message format.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

export { encrypt, decrypt } from './crypto.js';

// ---------------------------------------------------------------------------
// S3 object index (per-bucket flat key index, used for search)
// ---------------------------------------------------------------------------

export function deleteIndexDatabase(): void {
  if (indexDb) {
    indexDb.close();
    indexDb = null;
  }
  for (const path of [INDEX_DB_PATH, `${INDEX_DB_PATH}-wal`, `${INDEX_DB_PATH}-shm`]) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
  // Recreate immediately so the file exists with a fresh schema on return.
  getIndexDb();
}

export function getOrCreateIndexedBucket(endpointHost: string, bucket: string): number {
  const database = getIndexDb();
  database.prepare(`
    INSERT INTO s3_indexed_buckets (endpoint_host, bucket)
    VALUES (?, ?)
    ON CONFLICT(endpoint_host, bucket) DO NOTHING
  `).run(endpointHost, bucket);
  const row = database.prepare(`
    SELECT id FROM s3_indexed_buckets WHERE endpoint_host = ? AND bucket = ?
  `).get(endpointHost, bucket) as { id: number } | undefined;
  if (!row) {
    throw new Error('Failed to create indexed bucket row');
  }
  return row.id;
}

export function getIndexStatus(endpointHost: string, bucket: string): DbIndexedBucket | undefined {
  const database = getIndexDb();
  return database.prepare(`
    SELECT * FROM s3_indexed_buckets WHERE endpoint_host = ? AND bucket = ?
  `).get(endpointHost, bucket) as DbIndexedBucket | undefined;
}

export function markIndexCompleted(indexedBucketId: number, objectCount: number): void {
  const database = getIndexDb();
  database.prepare(`
    UPDATE s3_indexed_buckets
    SET last_completed_at = unixepoch(), object_count = ?
    WHERE id = ?
  `).run(objectCount, indexedBucketId);
}

export interface ObjectIndexInput {
  key: string;
  /** Unix epoch seconds. */
  lastModified: number;
  size: number | null;
  /** Decoded UTF-8 body (capped); null when the object is non-text or skipped. */
  content: string | null;
}

export interface ObjectIndexUpsertResult {
  added: number;
  updated: number;
  touched: number;
}

/** Existing row lookup result. Exported so the indexer can decide whether to refetch bodies. */
export interface ObjectIndexExistingRow {
  last_modified: number;
}

export function findObjectIndexRowsByKeys(
  indexedBucketId: number,
  keys: string[]
): Map<string, ObjectIndexExistingRow> {
  const result = new Map<string, ObjectIndexExistingRow>();
  if (keys.length === 0) return result;
  const database = getIndexDb();
  const stmt = database.prepare(`
    SELECT key, last_modified
    FROM s3_object_index
    WHERE indexed_bucket_id = ? AND key = ?
  `);
  for (const key of keys) {
    const row = stmt.get(indexedBucketId, key) as
      | (ObjectIndexExistingRow & { key: string })
      | undefined;
    if (row) {
      result.set(row.key, {
        last_modified: row.last_modified,
      });
    }
  }
  return result;
}

/**
 * Insert/update/touch a batch of objects for an indexed bucket within a single
 * transaction. Returns counts of each branch taken.
 *
 * Branches:
 *  - added:   no existing row -> INSERT
 *  - updated: existing row, last_modified differs -> UPDATE metadata + seen_at
 *  - touched: existing row, last_modified matches -> UPDATE seen_at only
 */
export function upsertObjectIndexBatch(
  indexedBucketId: number,
  seenAt: number,
  rows: ObjectIndexInput[]
): ObjectIndexUpsertResult {
  const database = getIndexDb();
  const findStmt = database.prepare(`
    SELECT id, last_modified FROM s3_object_index
    WHERE indexed_bucket_id = ? AND key = ?
  `);
  const insertStmt = database.prepare(`
    INSERT INTO s3_object_index (indexed_bucket_id, key, last_modified, size, seen_at, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateMetaStmt = database.prepare(`
    UPDATE s3_object_index
    SET last_modified = ?, size = ?, seen_at = ?, content = ?
    WHERE id = ?
  `);
  const touchStmt = database.prepare(`
    UPDATE s3_object_index SET seen_at = ? WHERE id = ?
  `);

  const result: ObjectIndexUpsertResult = { added: 0, updated: 0, touched: 0 };

  const apply = database.transaction((batch: ObjectIndexInput[]) => {
    for (const row of batch) {
      const existing = findStmt.get(indexedBucketId, row.key) as
        | { id: number; last_modified: number }
        | undefined;
      if (!existing) {
        insertStmt.run(
          indexedBucketId, row.key, row.lastModified, row.size, seenAt,
          row.content
        );
        result.added += 1;
      } else if (existing.last_modified === row.lastModified) {
        touchStmt.run(seenAt, existing.id);
        result.touched += 1;
      } else {
        updateMetaStmt.run(
          row.lastModified, row.size, seenAt,
          row.content, existing.id
        );
        result.updated += 1;
      }
    }
  });

  apply(rows);
  return result;
}

export function sweepStaleObjects(indexedBucketId: number, runStartedAt: number): number {
  const database = getIndexDb();
  const result = database.prepare(`
    DELETE FROM s3_object_index WHERE indexed_bucket_id = ? AND seen_at < ?
  `).run(indexedBucketId, runStartedAt);
  return result.changes;
}

export interface ObjectIndexSearchHit {
  key: string;
  /** Unix epoch seconds. */
  last_modified: number;
  size: number | null;
  /** ~30 chars of context around the first content match, or null when only the key matched. */
  contentSnippet: string | null;
  /** Total number of (case-insensitive ASCII) occurrences of the query in content. 0 when content didn't match. */
  contentMatchCount: number;
}

export interface ObjectIndexSearchResult {
  hits: ObjectIndexSearchHit[];
  total: number;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export type ObjectIndexSortKey = 'key' | 'last_modified';
export type ObjectIndexSortDir = 'asc' | 'desc';

export interface SearchObjectIndexOptions {
  limit: number;
  offset: number;
  sort?: ObjectIndexSortKey;
  dir?: ObjectIndexSortDir;
  prefix?: string;
}

export function searchObjectIndex(
  indexedBucketId: number,
  query: string,
  options: SearchObjectIndexOptions
): ObjectIndexSearchResult {
  const database = getIndexDb();

  // Match strategy: key substring (LIKE) OR content substring (LIKE on the
  // trigram-tokenized FTS5 virtual table, which uses the FTS index internally).
  // The trigram tokenizer handles CJK substrings that unicode61 cannot, since
  // unicode61 collapses runs of CJK characters into a single token.
  const likePattern = `%${escapeLikePattern(query)}%`;
  const whereParts: string[] = [
    'indexed_bucket_id = ?',
    `(
      key LIKE ? ESCAPE '\\'
      OR id IN (SELECT rowid FROM s3_object_content_fts WHERE content LIKE ? ESCAPE '\\')
    )`,
  ];
  const baseParams: (string | number)[] = [
    indexedBucketId,
    likePattern,
    likePattern,
  ];

  if (options.prefix) {
    whereParts.push("key LIKE ? ESCAPE '\\'");
    baseParams.push(`${escapeLikePattern(options.prefix)}%`);
  }

  const whereSql = whereParts.join(' AND ');

  const sortKey: ObjectIndexSortKey = options.sort === 'last_modified' ? 'last_modified' : 'key';
  const sortDir: ObjectIndexSortDir = options.dir === 'desc' ? 'desc' : 'asc';
  const orderSql = sortKey === 'last_modified'
    ? `last_modified ${sortDir}, key ASC`
    : `key ${sortDir}`;

  // Extract ~30 chars of context around the first case-insensitive (ASCII-only;
  // CJK passes through LOWER unchanged) occurrence of the query in content, plus
  // a total occurrence count via the LENGTH/REPLACE trick. INSTR/SUBSTR/LENGTH
  // all operate on characters in SQLite, so windows and counts are
  // character-accurate for CJK.
  const snippetSql = `
    CASE
      WHEN content IS NOT NULL AND INSTR(LOWER(content), LOWER(?)) > 0 THEN
        SUBSTR(
          content,
          MAX(1, INSTR(LOWER(content), LOWER(?)) - 30),
          LENGTH(?) + 60
        )
      ELSE NULL
    END AS contentSnippet,
    CASE
      WHEN content IS NOT NULL AND INSTR(LOWER(content), LOWER(?)) > 0 THEN
        (LENGTH(LOWER(content)) - LENGTH(REPLACE(LOWER(content), LOWER(?), ''))) / LENGTH(?)
      ELSE 0
    END AS contentMatchCount
  `;

  const sql = `
    SELECT key, last_modified, size, ${snippetSql}
    FROM s3_object_index
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `;

  const hits = database
    .prepare(sql)
    .all(
      query, query, query,         // snippet: needle, needle, needle (for LENGTH)
      query, query, query,         // count: needle (guard), needle (replace), needle (divisor)
      ...baseParams,
      options.limit,
      options.offset,
    ) as ObjectIndexSearchHit[];

  const totalRow = database.prepare(`
    SELECT COUNT(*) AS count
    FROM s3_object_index
    WHERE ${whereSql}
  `).get(...baseParams) as { count: number };

  return { hits, total: totalRow.count };
}
