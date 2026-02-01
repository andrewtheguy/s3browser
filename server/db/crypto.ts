import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // NIST-recommended 96-bit IV for AES-GCM
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_FILE_PATH = join(homedir(), '.s3browser', 'encryption.key');
const PASSWORD_FILE_PATH = join(homedir(), '.s3browser', 'login.password');

let encryptionKey: Buffer | null = null;
let encryptionSalt: Buffer | null = null;

function loadKeyFromFile(): string | null {
  if (!existsSync(KEY_FILE_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(KEY_FILE_PATH, 'utf8').trim();
    if (content.length >= 32) {
      return content;
    }
    console.warn(`Warning: ${KEY_FILE_PATH} exists but contains less than 32 characters`);
    return null;
  } catch (err) {
    console.warn(`Warning: Failed to read ${KEY_FILE_PATH}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function getEncryptionKey(): Buffer {
  if (encryptionKey) {
    return encryptionKey;
  }

  // First try environment variable
  let keySource = process.env.S3BROWSER_ENCRYPTION_KEY;

  // If not in env, try to load from file
  if (!keySource || keySource.length < 32) {
    const fileKey = loadKeyFromFile();
    if (fileKey) {
      keySource = fileKey;
    }
  }

  if (!keySource || keySource.length < 32) {
    throw new Error(
      `Encryption key not configured. Please either:\n` +
      `  1. Set S3BROWSER_ENCRYPTION_KEY environment variable (32+ characters), or\n` +
      `  2. Create ${KEY_FILE_PATH} with a 32+ character key\n` +
      `\nGenerate a key with: openssl rand -hex 32`
    );
  }

  if (!encryptionSalt) {
    throw new Error(
      'Encryption salt not initialized. This is an internal error - ' +
      'the database should initialize the salt before encryption operations.'
    );
  }

  // Derive a 256-bit key using scrypt
  encryptionKey = scryptSync(keySource, encryptionSalt, 32);
  return encryptionKey;
}

export function setSalt(salt: Buffer): void {
  if (salt.length !== SALT_LENGTH) {
    throw new Error(`Salt must be exactly ${SALT_LENGTH} bytes`);
  }
  encryptionSalt = salt;
  // Clear cached key so it's re-derived with new salt
  encryptionKey = null;
}

export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

export function getSaltLength(): number {
  return SALT_LENGTH;
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Format: iv (16 bytes) + authTag (16 bytes) + encrypted data
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
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

export function validateEncryptionKey(): void {
  getEncryptionKey();
}

export function getKeyFilePath(): string {
  return KEY_FILE_PATH;
}

function loadPasswordFromFile(): string | null {
  if (!existsSync(PASSWORD_FILE_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(PASSWORD_FILE_PATH, 'utf8').trim();
    if (content.length >= 8) {
      return content;
    }
    console.warn(`Warning: ${PASSWORD_FILE_PATH} exists but contains less than 8 characters`);
    return null;
  } catch (err) {
    console.warn(`Warning: Failed to read ${PASSWORD_FILE_PATH}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

let loginPassword: string | null = null;

export function getLoginPassword(): string {
  if (loginPassword) {
    return loginPassword;
  }

  // First try environment variable
  let password = process.env.S3BROWSER_LOGIN_PASSWORD;

  // If not in env, try to load from file
  if (!password) {
    password = loadPasswordFromFile() ?? undefined;
  }

  if (!password) {
    throw new Error(
      `Login password not configured. Please either:\n` +
      `  1. Set S3BROWSER_LOGIN_PASSWORD environment variable (8+ characters), or\n` +
      `  2. Create ${PASSWORD_FILE_PATH} with an 8+ character password\n`
    );
  }

  loginPassword = password;
  return loginPassword;
}

export function getPasswordFilePath(): string {
  return PASSWORD_FILE_PATH;
}

export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    // Compare against itself to maintain constant time
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

export function createHmacSignature(data: string, key: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}
