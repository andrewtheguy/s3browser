import { Request, Response, NextFunction } from 'express';
import { S3Client, HeadBucketCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  endpoint?: string;
}

export interface LoginInput {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket: string;
  endpoint?: string;
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

export function normalizeEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }
  return `https://${endpoint}`;
}

export function createSession(credentials: S3Credentials): string {
  const sessionId = generateSessionId();
  const endpoint = normalizeEndpoint(credentials.endpoint);

  const client = new S3Client({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    ...(endpoint && {
      endpoint,
      forcePathStyle: true, // Required for most S3-compatible services
    }),
  });

  sessions.set(sessionId, {
    credentials: { ...credentials, endpoint },
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

export async function getBucketRegion(
  accessKeyId: string,
  secretAccessKey: string,
  bucket: string,
  endpoint?: string
): Promise<string> {
  // For custom endpoints, region detection doesn't apply - use us-east-1 as default
  if (endpoint) {
    return 'us-east-1';
  }

  // Use us-east-1 as the initial region to query bucket location
  // GetBucketLocation works from any region but us-east-1 is the default
  const client = new S3Client({
    region: 'us-east-1',
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  try {
    const response = await client.send(new GetBucketLocationCommand({ Bucket: bucket }));
    // LocationConstraint is null/empty for us-east-1 buckets
    return response.LocationConstraint || 'us-east-1';
  } catch (error) {
    // If we can't get the location, default to us-east-1
    console.error('Failed to get bucket location:', error);
    throw new Error('Failed to detect bucket region. Please specify the region manually.');
  }
}

export async function validateCredentials(credentials: S3Credentials): Promise<{ valid: boolean; error?: string }> {
  const endpoint = normalizeEndpoint(credentials.endpoint);

  console.log('Validating credentials for bucket:', credentials.bucket, 'endpoint:', endpoint || 'AWS S3');

  const client = new S3Client({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    ...(endpoint && {
      endpoint,
      forcePathStyle: true,
    }),
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: credentials.bucket }));
    return { valid: true };
  } catch (error: unknown) {
    console.error('Credential validation error:', error);

    if (error instanceof Error) {
      // Bucket not found
      if (error.name === 'NotFound') {
        return { valid: false, error: 'Bucket not found' };
      }
      // Access denied - credentials might still be valid
      if (error.name === 'AccessDenied' || error.name === 'Forbidden') {
        return { valid: true };
      }
      // Invalid credentials
      if (error.name === 'InvalidAccessKeyId' || error.name === 'SignatureDoesNotMatch') {
        return { valid: false, error: 'Invalid credentials' };
      }
      // Network/connection errors
      if (error.name === 'NetworkingError' || error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        return { valid: false, error: `Cannot connect to endpoint: ${error.message}` };
      }
      return { valid: false, error: error.message };
    }
    return { valid: false, error: 'Unknown error' };
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
