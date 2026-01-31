import { Request, Response, NextFunction } from 'express';
import { S3Client, HeadBucketCommand, GetBucketLocationCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import {
  getSession as getDbSession,
  createSession as createDbSession,
  deleteSession as deleteDbSession,
  setSessionActiveConnection,
  setSessionActiveBucket,
  cleanupExpiredSessions,
  getUserByUsername,
  getConnectionById,
  updateConnectionLastUsed,
} from '../db/index.js';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket?: string;
  endpoint?: string;
}

export interface LoginInput {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket?: string;
  endpoint?: string;
}

export interface BucketInfo {
  name: string;
  creationDate?: string;
}

export interface SessionData {
  userId: number;
  username: string;
  activeConnectionId: number | null;
  credentials: S3Credentials | null;
  client: S3Client | null;
  createdAt: number;
}

// Clean up expired sessions periodically
setInterval(() => {
  const deleted = cleanupExpiredSessions();
  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} expired sessions`);
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

// Verify user credentials and create a session (no S3 credentials yet)
export async function verifyUserAndCreateSession(
  username: string,
  password: string
): Promise<{ sessionId: string; username: string } | null> {
  const user = getUserByUsername(username);
  if (!user) {
    return null;
  }

  const passwordValid = await bcrypt.compare(password, user.password_hash);
  if (!passwordValid) {
    return null;
  }

  const sessionId = createDbSession(user.id);
  return { sessionId, username: user.username };
}

// Create S3 client from credentials
function createS3Client(credentials: S3Credentials): S3Client {
  const endpoint = normalizeEndpoint(credentials.endpoint);

  return new S3Client({
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
}

// Activate a connection on an existing session
export function activateConnectionOnSession(
  sessionId: string,
  connectionId: number,
  bucket?: string
): boolean {
  const session = getDbSession(sessionId);
  if (!session) return false;

  setSessionActiveConnection(sessionId, connectionId);
  if (bucket) {
    setSessionActiveBucket(sessionId, bucket);
  }
  updateConnectionLastUsed(connectionId, session.user_id);

  return true;
}

export function getSession(sessionId: string): SessionData | undefined {
  const dbSession = getDbSession(sessionId);
  if (!dbSession) {
    return undefined;
  }

  // Build session data
  let credentials: S3Credentials | null = null;
  let client: S3Client | null = null;

  // If we have an active connection, use its credentials
  if (dbSession.active_connection_id && dbSession.connection_access_key_id && dbSession.connection_secret_access_key) {
    const endpoint = normalizeEndpoint(dbSession.connection_endpoint || undefined);
    credentials = {
      accessKeyId: dbSession.connection_access_key_id,
      secretAccessKey: dbSession.connection_secret_access_key,
      region: dbSession.connection_region || 'us-east-1',
      bucket: dbSession.active_bucket || undefined,
      endpoint,
    };
    client = createS3Client(credentials);
  }

  return {
    userId: dbSession.user_id,
    username: dbSession.username,
    activeConnectionId: dbSession.active_connection_id,
    credentials,
    client,
    createdAt: dbSession.created_at * 1000, // Convert to ms
  };
}

export function deleteSession(sessionId: string): boolean {
  deleteDbSession(sessionId);
  return true;
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
  const client = new S3Client({
    region: 'us-east-1',
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  try {
    const response = await client.send(new GetBucketLocationCommand({ Bucket: bucket }));
    return response.LocationConstraint || 'us-east-1';
  } catch (error) {
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
      if (error.name === 'NotFound') {
        return { valid: false, error: 'Bucket not found' };
      }
      if (error.name === 'AccessDenied' || error.name === 'Forbidden') {
        return { valid: true };
      }
      if (error.name === 'InvalidAccessKeyId' || error.name === 'SignatureDoesNotMatch') {
        return { valid: false, error: 'Invalid credentials' };
      }
      if (error.name === 'NetworkingError' || error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        return { valid: false, error: `Cannot connect to endpoint: ${error.message}` };
      }
      return { valid: false, error: error.message };
    }
    return { valid: false, error: 'Unknown error' };
  }
}

export async function validateCredentialsOnly(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  endpoint?: string
): Promise<{ valid: boolean; error?: string }> {
  const normalizedEndpoint = normalizeEndpoint(endpoint);

  console.log('Validating credentials (no bucket):', 'endpoint:', normalizedEndpoint || 'AWS');

  // For custom endpoints, use S3 ListBuckets as STS may not be available
  if (normalizedEndpoint) {
    const s3Client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      endpoint: normalizedEndpoint,
      forcePathStyle: true,
    });

    try {
      await s3Client.send(new ListBucketsCommand({}));
      return { valid: true };
    } catch (error: unknown) {
      console.error('Credential validation error (ListBuckets):', error);

      if (error instanceof Error) {
        if (error.name === 'ExpiredToken' || error.name === 'ExpiredTokenException' || error.message.includes('ExpiredToken')) {
          return { valid: false, error: 'Temporary credentials have expired - please refresh credentials' };
        }
        const msg = (error?.message ?? '').toLowerCase();
        const isSignatureError = error.name === 'SignatureDoesNotMatch' ||
          msg.includes('signature') ||
          msg.includes('credential');
        if (error.name === 'InvalidAccessKeyId' || isSignatureError) {
          return { valid: false, error: error.message || 'Invalid credentials or signature' };
        }
        if (error.name === 'AccessDenied' || error.name === 'Forbidden') {
          return { valid: true };
        }
        if (error.name === 'NetworkingError' || error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
          return { valid: false, error: `Cannot connect to endpoint: ${error.message}` };
        }
        return { valid: false, error: error.message };
      }
      return { valid: false, error: 'Unknown error' };
    }
  }

  // For AWS, try STS GetCallerIdentity first
  const stsClient = new STSClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  try {
    await stsClient.send(new GetCallerIdentityCommand({}));
    return { valid: true };
  } catch (error: unknown) {
    console.error('Credential validation error (STS):', error);

    if (error instanceof Error) {
      if (error.name === 'ExpiredToken' || error.name === 'ExpiredTokenException' || error.message.includes('ExpiredToken')) {
        return { valid: false, error: 'Temporary credentials have expired - please refresh credentials' };
      }
      const isSignatureError = error.name === 'SignatureDoesNotMatch' ||
        error.message.toLowerCase().includes('signature') ||
        error.message.toLowerCase().includes('credential');
      if (error.name === 'InvalidClientTokenId' || isSignatureError) {
        return { valid: false, error: error.message || 'Invalid credentials or signature' };
      }
      if (error.name === 'NetworkingError' || error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        return { valid: false, error: `Cannot connect to AWS: ${error.message}` };
      }

      // STS might be blocked - fall back to S3 ListBuckets
      if (error.name === 'AccessDenied' || error.name === 'Forbidden') {
        console.log('STS GetCallerIdentity denied (possibly by SCP), falling back to S3 ListBuckets');

        const s3Client = new S3Client({
          region,
          credentials: { accessKeyId, secretAccessKey },
        });

        try {
          await s3Client.send(new ListBucketsCommand({}));
          return { valid: true };
        } catch (s3Error: unknown) {
          console.error('Fallback S3 ListBuckets also failed:', s3Error);

          if (s3Error instanceof Error) {
            if (s3Error.name === 'ExpiredToken' || s3Error.name === 'ExpiredTokenException' || s3Error.message.includes('ExpiredToken')) {
              return { valid: false, error: 'Temporary credentials have expired - please refresh credentials' };
            }
            const isS3SignatureError = s3Error.name === 'SignatureDoesNotMatch' ||
              s3Error.message.toLowerCase().includes('signature') ||
              s3Error.message.toLowerCase().includes('credential');
            if (s3Error.name === 'InvalidAccessKeyId' || isS3SignatureError) {
              return { valid: false, error: s3Error.message || 'Invalid credentials or signature' };
            }
            if (s3Error.name === 'AccessDenied' || s3Error.name === 'Forbidden') {
              return { valid: true };
            }
          }
          const s3ErrorMessage = s3Error instanceof Error ? s3Error.message : String(s3Error);
          return { valid: false, error: `STS blocked by policy and S3 check failed: ${s3ErrorMessage}` };
        }
      }

      return { valid: false, error: error.message };
    }
    return { valid: false, error: 'Unknown error' };
  }
}

// Express middleware types
export interface AuthenticatedRequest extends Request {
  session?: SessionData;
  sessionId?: string;
}

// Middleware that requires user authentication (but not necessarily S3 credentials)
export function userAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const sessionId = req.cookies?.sessionId as string | undefined;

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
  req.sessionId = sessionId;
  next();
}

// Middleware that requires both user auth AND S3 credentials
export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const sessionId = req.cookies?.sessionId as string | undefined;

  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  if (!session.credentials || !session.client) {
    res.status(401).json({ error: 'S3 credentials not configured' });
    return;
  }

  req.session = session;
  req.sessionId = sessionId;
  next();
}

// Middleware that requires a bucket to be selected (use after authMiddleware)
export function requireBucket(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.session?.credentials?.bucket) {
    res.status(400).json({ error: 'No bucket selected. Please select a bucket first.' });
    return;
  }
  next();
}

// List buckets for the authenticated user
export async function listUserBuckets(client: S3Client): Promise<BucketInfo[]> {
  const command = new ListBucketsCommand({});
  const response = await client.send(command);

  return (response.Buckets || []).map(bucket => ({
    name: bucket.Name || '',
    creationDate: bucket.CreationDate?.toISOString(),
  })).filter(b => b.name);
}

// Update session bucket after selection
export function updateSessionBucket(sessionId: string, bucket: string): boolean {
  const session = getSession(sessionId);
  if (!session) return false;

  setSessionActiveBucket(sessionId, bucket);
  return true;
}

// Get connection by ID (for activation endpoint)
export function getConnectionForSession(connectionId: number, userId: number) {
  return getConnectionById(connectionId, userId);
}

// Validate a specific bucket for an existing session
export async function validateBucket(
  client: S3Client,
  bucket: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { valid: true };
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.name === 'NotFound') {
        return { valid: false, error: 'Bucket not found' };
      }
      if (error.name === 'AccessDenied' || error.name === 'Forbidden') {
        return { valid: true };
      }
      return { valid: false, error: error.message };
    }
    return { valid: false, error: 'Unknown error' };
  }
}
