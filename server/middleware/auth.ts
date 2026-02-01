import { Request, Response, NextFunction } from 'express';
import { S3Client, HeadBucketCommand, GetBucketLocationCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { verifyAuthToken, createAuthToken, AUTH_COOKIE_OPTIONS, AUTH_COOKIE_NAME } from '../auth/token.js';
import {
  getConnectionById,
  updateConnectionLastUsed,
  decryptConnectionSecretKey,
  type DbS3Connection,
} from '../db/index.js';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket?: string;
  endpoint?: string;
}

export interface BucketInfo {
  name: string;
  creationDate?: string;
}

export function normalizeEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }
  return `https://${endpoint}`;
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

// Create S3 client from a database connection
export function createS3ClientFromConnection(connection: DbS3Connection, bucket?: string): { client: S3Client; credentials: S3Credentials } {
  const secretAccessKey = decryptConnectionSecretKey(connection);
  const endpoint = normalizeEndpoint(connection.endpoint);

  const credentials: S3Credentials = {
    accessKeyId: connection.access_key_id,
    secretAccessKey,
    region: connection.region || 'us-east-1',
    bucket: bucket || connection.bucket || undefined,
    endpoint,
  };

  const client = createS3Client(credentials);
  return { client, credentials };
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
  connectionId?: number;
  s3Connection?: DbS3Connection;
  s3Client?: S3Client;
  s3Credentials?: S3Credentials;
}

// Request with S3 client and credentials guaranteed
export interface S3AuthenticatedRequest extends Request {
  connectionId: number;
  s3Connection: DbS3Connection;
  s3Client: S3Client;
  s3Credentials: S3Credentials;
}

// Request with bucket guaranteed
export interface S3AuthenticatedRequestWithBucket extends Request {
  connectionId: number;
  s3Connection: DbS3Connection;
  s3Client: S3Client;
  s3Credentials: S3Credentials & { bucket: string };
}

// Simple login middleware - checks auth cookie and refreshes it on activity
export function loginMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const token = req.cookies?.[AUTH_COOKIE_NAME] as string | undefined;

  if (!token || !verifyAuthToken(token)) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // Refresh token on each authenticated request (sliding expiration)
  // Session only expires after 4 hours of inactivity (validated in token)
  res.cookie(AUTH_COOKIE_NAME, createAuthToken(), AUTH_COOKIE_OPTIONS);

  next();
}

// S3 middleware - creates S3 client from connection ID in URL params
export function s3Middleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // First check login
  loginMiddleware(req, res, () => {
    const connectionId = parseInt(req.params.connectionId as string, 10);
    const bucket = req.params.bucket as string | undefined;

    if (isNaN(connectionId) || connectionId <= 0) {
      res.status(400).json({ error: 'Valid connection ID is required' });
      return;
    }

    const connection = getConnectionById(connectionId);
    if (!connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    // Create S3 client from connection
    const { client, credentials } = createS3ClientFromConnection(connection, bucket);

    req.connectionId = connectionId;
    req.s3Connection = connection;
    req.s3Client = client;
    req.s3Credentials = credentials;

    // Update last used timestamp
    updateConnectionLastUsed(connectionId);

    next();
  });
}

// Middleware that requires a bucket to be selected (use after s3Middleware)
export function requireBucket(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.s3Credentials?.bucket) {
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
