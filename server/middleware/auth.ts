import { Request, Response, NextFunction } from 'express';
import { S3Client, HeadBucketCommand, GetBucketLocationCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import crypto from 'crypto';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket?: string;  // Optional - can be selected after login
  endpoint?: string;
}

export interface LoginInput {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket?: string;  // Optional - can be selected after login
  endpoint?: string;
}

export interface BucketInfo {
  name: string;
  creationDate?: string;
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

// Validate credentials without requiring a bucket (uses STS GetCallerIdentity)
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
        if (error.name === 'InvalidAccessKeyId' || error.name === 'SignatureDoesNotMatch') {
          return { valid: false, error: 'Invalid credentials' };
        }
        if (error.name === 'AccessDenied' || error.name === 'Forbidden') {
          // Credentials are valid but user lacks ListBuckets permission - that's OK
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

  // For AWS, try STS GetCallerIdentity first (lightweight check).
  // Note: SCPs or explicit deny policies can block sts:GetCallerIdentity even for valid credentials,
  // causing false negatives. If STS is denied, we fall back to S3 ListBuckets.
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
      if (error.name === 'InvalidClientTokenId' || error.name === 'SignatureDoesNotMatch') {
        return { valid: false, error: 'Invalid credentials' };
      }
      if (error.name === 'NetworkingError' || error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        return { valid: false, error: `Cannot connect to AWS: ${error.message}` };
      }

      // STS might be blocked by SCP or explicit deny - fall back to S3 ListBuckets
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
            if (s3Error.name === 'InvalidAccessKeyId' || s3Error.name === 'SignatureDoesNotMatch') {
              return { valid: false, error: 'Invalid credentials' };
            }
            if (s3Error.name === 'AccessDenied' || s3Error.name === 'Forbidden') {
              // Both STS and S3 ListBuckets denied - credentials likely valid but restricted
              // Allow login and let bucket-specific operations determine access
              return { valid: true };
            }
          }
          // Return S3 fallback error since that's what actually failed
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
  if (!req.session?.credentials.bucket) {
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
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.credentials.bucket = bucket;
  return true;
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
        // Access denied might still mean the bucket exists - allow it
        return { valid: true };
      }
      return { valid: false, error: error.message };
    }
    return { valid: false, error: 'Unknown error' };
  }
}
