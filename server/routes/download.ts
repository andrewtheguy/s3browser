import { Router, Response } from 'express';
import path from 'path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Middleware, requireBucket, AuthenticatedRequest } from '../middleware/auth.js';

// Check for control characters (0x00-0x1f, 0x7f) or backslashes
function hasUnsafeChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || str[i] === '\\') {
      return true;
    }
  }
  return false;
}

function validateKey(key: unknown): { valid: false; error: string } | { valid: true; validatedKey: string } {
  // Handle array case - reject if multiple values
  if (Array.isArray(key)) {
    return { valid: false, error: 'Multiple key values not allowed' };
  }

  // Ensure key is a string
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Object key is required' };
  }

  // Reject control characters and backslashes
  if (hasUnsafeChars(key)) {
    return { valid: false, error: 'Invalid character in key: control characters and backslashes not allowed' };
  }

  // Reject absolute paths
  if (key.startsWith('/')) {
    return { valid: false, error: 'Absolute paths not allowed' };
  }

  // Normalize path and check for directory traversal or invalid results
  const normalized = path.posix.normalize(key);
  if (normalized.startsWith('..') || normalized === '.' || normalized === '') {
    return { valid: false, error: 'Directory traversal not allowed' };
  }

  return { valid: true, validatedKey: normalized };
}

const router = Router();

// All routes use s3Middleware which checks auth and creates S3 client from connectionId
// Routes: /api/download/:connectionId/:bucket/...

// GET /api/download/:connectionId/:bucket/preview?key= (proxied content for preview)
router.get('/:connectionId/:bucket/preview', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  if (!bucket || !client) {
    console.error('Download preview route missing S3 context:', {
      route: 'GET /api/download/:connectionId/:bucket/preview',
      method: req.method,
      path: req.path,
      hasBucket: !!bucket,
      hasClient: !!client,
    });
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const keyValidation = validateKey(req.query.key);
  if (!keyValidation.valid) {
    res.status(400).json({ error: keyValidation.error });
    return;
  }

  // Limit content size for preview (256KB)
  const MAX_PREVIEW_SIZE = 262144;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: keyValidation.validatedKey,
    Range: `bytes=0-${MAX_PREVIEW_SIZE - 1}`,
  });

  try {
    const response = await client.send(command);
    const bodyStream = response.Body;

    if (!bodyStream) {
      res.status(404).json({ error: 'File not found or empty' });
      return;
    }

    // Convert stream to string
    const chunks: Uint8Array[] = [];
    for await (const chunk of bodyStream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const content = buffer.toString('utf-8');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch (error) {
    console.error('Failed to fetch file content:', error);
    res.status(500).json({ error: 'Failed to fetch file content' });
  }
});

// GET /api/download/:connectionId/:bucket/url?key=
router.get('/:connectionId/:bucket/url', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check: s3Middleware should populate these, but verify to avoid runtime errors
  if (!bucket || !client) {
    console.error('Download route missing S3 context:', {
      route: 'GET /api/download/:connectionId/:bucket/url',
      method: req.method,
      path: req.path,
      hasBucket: !!bucket,
      hasClient: !!client,
    });
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const keyValidation = validateKey(req.query.key);
  if (!keyValidation.valid) {
    res.status(400).json({ error: keyValidation.error });
    return;
  }

  // Parse TTL from query parameter, default to 1 hour (3600 seconds)
  const DEFAULT_TTL = 3600;
  const MAX_TTL = 604800; // 7 days maximum
  const MIN_TTL = 60; // 1 minute minimum
  let ttl = DEFAULT_TTL;

  if (req.query.ttl !== undefined) {
    const parsedTtl = parseInt(req.query.ttl as string, 10);
    if (isNaN(parsedTtl) || parsedTtl < MIN_TTL || parsedTtl > MAX_TTL) {
      res.status(400).json({ error: `TTL must be between ${MIN_TTL} and ${MAX_TTL} seconds` });
      return;
    }
    ttl = parsedTtl;
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: keyValidation.validatedKey,
  });

  try {
    const url = await getSignedUrl(client, command, { expiresIn: ttl });
    res.json({ url });
  } catch (error) {
    console.error('Failed to generate presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

export default router;
