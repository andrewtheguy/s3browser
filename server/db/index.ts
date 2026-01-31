import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { validateEncryptionKey, encrypt, decrypt } from './crypto.js';

// Database directory and file path
const DB_DIR = join(homedir(), '.s3browser');
const DB_PATH = join(DB_DIR, 's3browser.db');

let db: Database | null = null;

export interface DbUser {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
}

export interface DbSession {
  id: string;
  user_id: number;
  active_connection_id: number | null;
  active_bucket: string | null;
  created_at: number;
  expires_at: number;
}

export interface DbS3Connection {
  id: number;
  user_id: number;
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
  // Check if metadata table exists
  const tableExists = database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'
  `).get();

  if (!tableExists) {
    // First run - create table and store encrypted canary
    database.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const encryptedCanary = encrypt(KEY_CHECK_CANARY);
    database.prepare(`INSERT INTO metadata (key, value) VALUES ('key_check', ?)`).run(encryptedCanary);
    return;
  }

  // Existing database - verify the canary
  const row = database.prepare(`SELECT value FROM metadata WHERE key = 'key_check'`).get() as { value: string } | undefined;

  if (!row) {
    // Metadata table exists but no key_check - this shouldn't happen normally
    // Store the canary for future checks
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
      'To fix this, use the original encryption key, or delete ~/.s3browser/s3browser.db to start fresh (this will delete all users and saved connections).'
    );
  }
}

function initializeDatabase(): Database {
  // Validate encryption key before database initialization
  validateEncryptionKey();

  // Ensure the database directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  // Open database
  const database = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  database.exec('PRAGMA journal_mode = WAL');

  // Create tables
  database.exec(`
    -- Users: simple username/password accounts
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Sessions: replaces in-memory Map
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      active_connection_id INTEGER REFERENCES s3_connections(id) ON DELETE SET NULL,
      active_bucket TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );

    -- S3 connections: saved S3 connection profiles per user
    CREATE TABLE IF NOT EXISTS s3_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      access_key_id TEXT NOT NULL,
      secret_access_key TEXT NOT NULL,
      bucket TEXT,
      region TEXT,
      auto_detect_region INTEGER DEFAULT 1,
      last_used_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(user_id, name)
    );

    -- Create indexes for better query performance
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_s3_connections_user_id ON s3_connections(user_id);
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

// User operations
export function createUser(username: string, passwordHash: string): DbUser {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO users (username, password_hash)
    VALUES (?, ?)
    RETURNING *
  `);
  return stmt.get(username, passwordHash) as DbUser;
}

export function getUserByUsername(username: string): DbUser | undefined {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM users WHERE username = ?');
  return stmt.get(username) as DbUser | undefined;
}

export function getUserById(id: number): DbUser | undefined {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id) as DbUser | undefined;
}

// Session operations
const SESSION_DURATION_HOURS = 4;

export function createSession(userId: number): string {
  const database = getDb();
  const sessionId = randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION_HOURS * 60 * 60;

  const stmt = database.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(sessionId, userId, expiresAt);

  return sessionId;
}

export interface SessionWithConnection extends DbSession {
  username: string;
  // Connection fields (null if no active connection)
  connection_name: string | null;
  connection_endpoint: string | null;
  connection_access_key_id: string | null;
  connection_secret_access_key: string | null;
  connection_region: string | null;
}

export function getSession(sessionId: string): SessionWithConnection | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT
      s.*,
      u.username,
      c.name as connection_name,
      c.endpoint as connection_endpoint,
      c.access_key_id as connection_access_key_id,
      c.secret_access_key as connection_secret_access_key,
      c.region as connection_region
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN s3_connections c ON s.active_connection_id = c.id
    WHERE s.id = ? AND s.expires_at > unixepoch()
  `);
  const row = stmt.get(sessionId) as SessionWithConnection | undefined;

  if (row && row.connection_secret_access_key) {
    // Decrypt the secret access key
    try {
      row.connection_secret_access_key = decrypt(row.connection_secret_access_key);
    } catch {
      console.error('Failed to decrypt S3 credentials for session');
      return undefined;
    }
  }

  return row;
}

export function setSessionActiveConnection(sessionId: string, connectionId: number): void {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE sessions SET active_connection_id = ? WHERE id = ?
  `);
  stmt.run(connectionId, sessionId);
}

export function setSessionActiveBucket(sessionId: string, bucket: string): void {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE sessions SET active_bucket = ? WHERE id = ?
  `);
  stmt.run(bucket, sessionId);
}

export function deleteSession(sessionId: string): void {
  const database = getDb();
  const stmt = database.prepare('DELETE FROM sessions WHERE id = ?');
  stmt.run(sessionId);
}

export function cleanupExpiredSessions(): number {
  const database = getDb();
  const stmt = database.prepare('DELETE FROM sessions WHERE expires_at <= unixepoch()');
  const result = stmt.run();
  return result.changes;
}

// S3 Connections operations
export function getConnectionsByUserId(userId: number): DbS3Connection[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM s3_connections
    WHERE user_id = ?
    ORDER BY last_used_at DESC
  `);
  return stmt.all(userId) as DbS3Connection[];
}

export function getConnectionById(connectionId: number, userId: number): DbS3Connection | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM s3_connections
    WHERE id = ? AND user_id = ?
  `);
  return stmt.get(connectionId, userId) as DbS3Connection | undefined;
}

export function getConnectionByName(userId: number, name: string): DbS3Connection | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM s3_connections
    WHERE user_id = ? AND name = ?
  `);
  return stmt.get(userId, name) as DbS3Connection | undefined;
}

export function saveConnection(
  userId: number,
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
    INSERT INTO s3_connections (user_id, name, endpoint, access_key_id, secret_access_key, bucket, region, auto_detect_region, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id, name) DO UPDATE SET
      endpoint = excluded.endpoint,
      access_key_id = excluded.access_key_id,
      secret_access_key = excluded.secret_access_key,
      bucket = excluded.bucket,
      region = excluded.region,
      auto_detect_region = excluded.auto_detect_region,
      last_used_at = unixepoch()
    RETURNING *
  `);
  return stmt.get(userId, name, endpoint, accessKeyId, encryptedSecretAccessKey, bucket, region, autoDetectRegion ? 1 : 0) as DbS3Connection;
}

export function deleteConnection(userId: number, name: string): boolean {
  const database = getDb();
  const stmt = database.prepare('DELETE FROM s3_connections WHERE user_id = ? AND name = ?');
  const result = stmt.run(userId, name);
  return result.changes > 0;
}

export function updateConnectionLastUsed(connectionId: number): void {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE s3_connections SET last_used_at = unixepoch() WHERE id = ?
  `);
  stmt.run(connectionId);
}

export function decryptConnectionSecretKey(connection: DbS3Connection): string {
  return decrypt(connection.secret_access_key);
}

export { encrypt, decrypt } from './crypto.js';
