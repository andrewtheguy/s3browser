import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { validateEncryptionKey, encrypt, decrypt, setSalt, generateSalt, getSaltLength } from './crypto.js';

// Database directory and file path
const DB_DIR = join(homedir(), '.s3browser');
const DB_PATH = join(DB_DIR, 's3browser.db');

let db: Database | null = null;

export interface DbS3Connection {
  id: number;
  name: string;
  endpoint: string;
  access_key_id: string;
  secret_access_key: string;
  bucket: string | null;
  region: string | null;
  auto_detect_region: number;
  last_used_at: number;
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

function initializeDatabase(): Database {
  // Ensure the database directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  // Open database
  const database = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  database.exec('PRAGMA journal_mode = WAL');

  // Initialize salt from database (must happen before encryption key validation)
  initializeSalt(database);

  // Now validate encryption key (which requires salt to be set)
  validateEncryptionKey();

  // Create tables
  database.exec(`
    -- S3 connections: saved S3 connection profiles (globally unique names)
    CREATE TABLE IF NOT EXISTS s3_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
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

export function getDb(): Database {
  if (!db) {
    db = initializeDatabase();
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
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

export function getConnectionByName(name: string): DbS3Connection | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM s3_connections
    WHERE name = ?
  `);
  return stmt.get(name) as DbS3Connection | undefined;
}

export function saveConnection(
  name: string,
  endpoint: string,
  accessKeyId: string,
  secretAccessKey: string,
  bucket: string | null,
  region: string | null,
  autoDetectRegion: boolean
): DbS3Connection {
  const database = getDb();
  const encryptedSecretAccessKey = encrypt(secretAccessKey);

  const stmt = database.prepare(`
    INSERT INTO s3_connections (name, endpoint, access_key_id, secret_access_key, bucket, region, auto_detect_region, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(name) DO UPDATE SET
      endpoint = excluded.endpoint,
      access_key_id = excluded.access_key_id,
      secret_access_key = excluded.secret_access_key,
      bucket = excluded.bucket,
      region = excluded.region,
      auto_detect_region = excluded.auto_detect_region,
      last_used_at = unixepoch()
    RETURNING *
  `);
  return stmt.get(name, endpoint, accessKeyId, encryptedSecretAccessKey, bucket, region, autoDetectRegion ? 1 : 0) as DbS3Connection;
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

export { encrypt, decrypt } from './crypto.js';
