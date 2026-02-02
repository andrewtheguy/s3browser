import { scryptSync } from 'crypto';
import { getLoginPassword, createHmacSignature, timingSafeCompare } from '../db/crypto.js';

const TOKEN_EXPIRATION_HOURS = 4;
const CLOCK_SKEW_SECONDS = 30;
const JWT_ALGORITHM = 'HS256';
const JWT_TYPE = 'JWT';
const JWT_HEADER_B64 = Buffer.from(
  JSON.stringify({ alg: JWT_ALGORITHM, typ: JWT_TYPE })
).toString('base64url');

// Unique cookie name for this application
export const AUTH_COOKIE_NAME = 's3browser_auth_token';

// Cookie options for auth token (session cookie - expires when browser closes)
export const AUTH_COOKIE_OPTIONS: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
} = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
};

interface TokenPayload {
  iat: number; // Issued at (Unix timestamp)
  exp: number; // Expires at (Unix timestamp)
}

let signingKey: string | null = null;

function getSigningKey(): string {
  if (signingKey) {
    return signingKey;
  }

  // Derive signing key from login password
  const password = getLoginPassword();
  const salt = 's3browser-auth-token-v1';
  signingKey = scryptSync(password, salt, 32).toString('base64url');
  return signingKey;
}

export function createAuthToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    iat: now,
    exp: now + TOKEN_EXPIRATION_HOURS * 60 * 60,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${JWT_HEADER_B64}.${payloadB64}`;
  const signature = createHmacSignature(signingInput, getSigningKey());

  return `${JWT_HEADER_B64}.${payloadB64}.${signature}`;
}

export function verifyAuthToken(token: string): boolean {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }

  const [headerB64, payloadB64, signature] = parts;

  // Parse and validate header
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
      alg?: string;
      typ?: string;
    };
  } catch {
    return false;
  }

  if (header.alg !== JWT_ALGORITHM || header.typ !== JWT_TYPE) {
    return false;
  }

  // Verify signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSignature = createHmacSignature(signingInput, getSigningKey());
  if (!timingSafeCompare(signature, expectedSignature)) {
    return false;
  }

  // Parse and verify payload
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return false;
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    return false;
  }

  // Check issued at is valid (not in the future, with clock skew tolerance)
  if (typeof payload.iat !== 'number' || payload.iat > now + CLOCK_SKEW_SECONDS) {
    return false;
  }

  return true;
}
