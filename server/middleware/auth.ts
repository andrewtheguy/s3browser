import { Request, Response, NextFunction } from 'express';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
}

interface SessionData {
  credentials: S3Credentials;
  client: S3Client;
  createdAt: number;
}

// In-memory session store
const sessions = new Map<string, SessionData>();

// Session expiry: 4 hours
const SESSION_EXPIRY_MS = 4 * 60 * 60 * 1000;

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, data] of sessions) {
    if (now - data.createdAt > SESSION_EXPIRY_MS) {
      sessions.delete(sessionId);
    }
  }
}, 60 * 1000); // Check every minute

export function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function createSession(credentials: S3Credentials): string {
  const sessionId = generateSessionId();
  const client = new S3Client({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });

  sessions.set(sessionId, {
    credentials,
    client,
    createdAt: Date.now(),
  });

  return sessionId;
}

export function getSession(sessionId: string): SessionData | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  // Check if expired
  if (Date.now() - session.createdAt > SESSION_EXPIRY_MS) {
    sessions.delete(sessionId);
    return undefined;
  }

  return session;
}

export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export async function validateCredentials(credentials: S3Credentials): Promise<boolean> {
  const client = new S3Client({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: credentials.bucket }));
    return true;
  } catch (error: unknown) {
    // HeadBucket may fail due to permissions but credentials could still be valid
    // Check if it's an access denied vs invalid credentials
    if (error instanceof Error && error.name === 'NotFound') {
      return false;
    }
    // For other errors (like AccessDenied), credentials might still be valid
    // but user doesn't have HeadBucket permission - we'll allow it
    if (error instanceof Error && (error.name === 'AccessDenied' || error.name === 'Forbidden')) {
      return true;
    }
    return false;
  }
}

// Express middleware types
export interface AuthenticatedRequest extends Request {
  session?: SessionData;
}

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const sessionId = req.cookies?.sessionId;

  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  req.session = session;
  next();
}
