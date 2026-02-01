import { scryptSync } from 'crypto';
import { getLoginPassword, createHmacSignature, timingSafeCompare } from '../db/crypto.js';

const TOKEN_EXPIRATION_HOURS = 4;

// Cookie options for auth token
export const AUTH_COOKIE_OPTIONS: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  maxAge: number;
} = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: TOKEN_EXPIRATION_HOURS * 60 * 60 * 1000, // 4 hours in milliseconds
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
  const signature = createHmacSignature(payloadB64, getSigningKey());

  return `${payloadB64}.${signature}`;
}

export function verifyAuthToken(token: string): boolean {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }

  const [payloadB64, signature] = parts;

  // Verify signature
  const expectedSignature = createHmacSignature(payloadB64, getSigningKey());
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

  // Check issued at is valid (not in the future)
  if (typeof payload.iat !== 'number' || payload.iat > now) {
    return false;
  }

  return true;
}
