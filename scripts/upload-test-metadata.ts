/**
 * One-time script to upload a test file with custom metadata to Backblaze B2.
 * Run with: bun scripts/upload-test-metadata.ts
 */

import { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Crypto constants (must match server/db/crypto.ts)
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_FILE_PATH = join(homedir(), '.s3browser', 'encryption.key');
const DB_PATH = join(homedir(), '.s3browser', 's3browser.db');

// Load encryption key
function loadEncryptionKey(): string {
  // First try environment variable
  let keySource = process.env.S3BROWSER_ENCRYPTION_KEY;

  // If not in env, try to load from file
  if (!keySource || keySource.length < 32) {
    if (existsSync(KEY_FILE_PATH)) {
      keySource = readFileSync(KEY_FILE_PATH, 'utf8').trim();
    }
  }

  if (!keySource || keySource.length < 32) {
    throw new Error('Encryption key not found');
  }

  return keySource;
}

// Decrypt function
function decrypt(ciphertext: string, key: Buffer): string {
  const combined = Buffer.from(ciphertext, 'base64');

  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid ciphertext: too short');
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

async function main() {
  // Open database
  const db = new Database(DB_PATH, { readonly: true });

  // Get salt from metadata
  const saltRow = db.prepare(`SELECT value FROM metadata WHERE key = 'encryption_salt'`).get() as { value: string } | undefined;
  if (!saltRow) {
    throw new Error('Salt not found in database');
  }
  const salt = Buffer.from(saltRow.value, 'base64');

  // Load and derive encryption key
  const keySource = loadEncryptionKey();
  const encryptionKey = scryptSync(keySource, salt, 32);

  // Find the Backblaze connection
  const connection = db.prepare(`
    SELECT * FROM s3_connections WHERE name LIKE '%backblaze%' OR endpoint LIKE '%backblaze%'
  `).get() as {
    id: number;
    name: string;
    endpoint: string;
    access_key_id: string;
    secret_access_key: string;
    bucket: string | null;
    region: string | null;
  } | undefined;

  if (!connection) {
    throw new Error('Backblaze connection not found');
  }

  console.log(`Found connection: ${connection.name}`);
  console.log(`Endpoint: ${connection.endpoint}`);
  console.log(`Bucket: ${connection.bucket || 'not set'}`);

  // Decrypt secret access key
  const secretAccessKey = decrypt(connection.secret_access_key, encryptionKey);

  // Create S3 client
  const client = new S3Client({
    endpoint: connection.endpoint,
    region: connection.region || 'us-west-004',
    credentials: {
      accessKeyId: connection.access_key_id,
      secretAccessKey: secretAccessKey,
    },
  });

  const bucket = 'andrewtheguy-data';
  const key = 'test-metadata-file.txt';
  const content = 'This is a test file with custom metadata.\nCreated: ' + new Date().toISOString();

  // Upload with custom metadata
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: content,
    ContentType: 'text/plain',
    CacheControl: 'max-age=3600',
    ContentDisposition: 'inline; filename="test-file.txt"',
    ContentEncoding: 'identity',
    Metadata: {
      'custom-key-1': 'custom-value-1',
      'author': 'claude-test-script',
      'purpose': 'testing-metadata-display',
    },
  });

  console.log('\nUploading file with metadata...');
  console.log(`  Bucket: ${bucket}`);
  console.log(`  Key: ${key}`);
  console.log(`  Cache-Control: max-age=3600`);
  console.log(`  Content-Disposition: inline; filename="test-file.txt"`);
  console.log(`  Content-Encoding: identity`);
  console.log(`  Custom Metadata:`);
  console.log(`    custom-key-1: custom-value-1`);
  console.log(`    author: claude-test-script`);
  console.log(`    purpose: testing-metadata-display`);

  try {
    await client.send(command);
    console.log('\nUpload successful!');
    console.log(`\nYou can now view the file details in the S3 Browser app to verify the metadata is displayed.`);
  } catch (error) {
    console.error('\nUpload failed:', error);
    process.exit(1);
  }

  db.close();
}

main().catch(console.error);
