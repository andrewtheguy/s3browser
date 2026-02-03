import { Router, Response } from 'express';
import path from 'path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Middleware, requireBucket, AuthenticatedRequest } from '../middleware/auth.js';

interface NodeReadableStreamLike {
  pipe: (destination: Response) => unknown;
  on: (event: 'data' | 'end' | 'error' | 'close', handler: (chunk?: unknown) => void) => void;
  destroy?: (error?: unknown) => void;
}

interface WebReadableStreamReaderLike {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?: (reason?: unknown) => Promise<void>;
  releaseLock?: () => void;
}

interface WebReadableStreamLike {
  getReader: () => WebReadableStreamReaderLike;
}

function isNodeReadableStream(value: unknown): value is NodeReadableStreamLike {
  return typeof value === 'object'
    && value !== null
    && 'pipe' in value
    && typeof (value as { pipe?: unknown }).pipe === 'function'
    && 'on' in value
    && typeof (value as { on?: unknown }).on === 'function';
}

function isWebReadableStream(value: unknown): value is WebReadableStreamLike {
  return typeof value === 'object'
    && value !== null
    && 'getReader' in value
    && typeof (value as { getReader?: unknown }).getReader === 'function';
}

async function pipeWebStreamToResponse(stream: WebReadableStreamLike, res: Response): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && !res.writableEnded) {
        res.write(Buffer.from(value));
      }
      if (res.writableEnded) {
        await reader.cancel?.();
        break;
      }
    }
  } finally {
    reader.releaseLock?.();
    if (!res.writableEnded) {
      res.end();
    }
  }
}

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

// Validate contentType for ResponseContentType header
// Returns the contentType if valid, undefined otherwise
function validateContentType(contentType: string | undefined): string | undefined {
  if (!contentType || typeof contentType !== 'string') {
    return undefined;
  }

  // Check for control characters
  for (let i = 0; i < contentType.length; i++) {
    const code = contentType.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return undefined;
    }
  }

  // Basic MIME type format validation: type/subtype with optional parameters
  // Allow: letters, digits, hyphens, dots, plus signs, slashes, semicolons, equals, spaces
  // Reject anything that doesn't match basic MIME structure
  const mimePattern = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*(?:;\s*[a-zA-Z0-9\-_.]+=[a-zA-Z0-9\-_.]+)*$/;
  if (!mimePattern.test(contentType)) {
    return undefined;
  }

  // Reject excessively long values
  if (contentType.length > 256) {
    return undefined;
  }

  return contentType;
}

// Sanitize filename for Content-Disposition header
function sanitizeFilename(filename: string): string {
  // Remove control characters, double quotes, and semicolons; normalize whitespace
  let result = '';
  for (let i = 0; i < filename.length; i++) {
    const code = filename.charCodeAt(i);
    // Skip control characters (0x00-0x1f, 0x7f) and unsafe header chars (", ;)
    if (code <= 0x1f || code === 0x7f || filename[i] === '"' || filename[i] === ';') {
      continue;
    }
    result += filename[i];
  }
  // Collapse whitespace to single spaces and trim
  const sanitized = result.replace(/\s+/g, ' ').trim();

  // Fall back to default if result is empty
  return sanitized || 'download';
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

function isAccessDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const named = err as { name?: string; Code?: string; code?: string; message?: string };
  const name = (named.name ?? named.Code ?? named.code ?? '').toLowerCase();
  const message = (named.message ?? '').toLowerCase();

  return name === 'accessdenied'
    || name === 'forbidden'
    || message.includes('accessdenied')
    || message.includes('forbidden');
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const named = err as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const name = (named.name ?? named.Code ?? named.code ?? '').toLowerCase();
  const status = named.$metadata?.httpStatusCode;

  return name === 'nosuchkey' || name === 'notfound' || status === 404;
}

const router = Router();

// All routes use s3Middleware which checks auth and creates S3 client from connectionId
// Routes: /api/download/:connectionId/:bucket/...

// GET /api/download/:connectionId/:bucket/url?key=&disposition=inline|attachment
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
  const versionId = typeof req.query.versionId === 'string' &&
    req.query.versionId.trim() &&
    !hasUnsafeChars(req.query.versionId)
    ? req.query.versionId
    : undefined;

  // Parse TTL from query parameter, default to 1 hour (3600 seconds)
  const DEFAULT_TTL = 3600;
  const MAX_TTL = 604800; // 7 days maximum
  const MIN_TTL = 60; // 1 minute minimum
  let ttl = DEFAULT_TTL;

  if (req.query.ttl !== undefined) {
    if (Array.isArray(req.query.ttl)) {
      res.status(400).json({ error: 'TTL must be a single value' });
      return;
    }
    const parsedTtl = parseInt(req.query.ttl as string, 10);
    if (isNaN(parsedTtl) || parsedTtl < MIN_TTL || parsedTtl > MAX_TTL) {
      res.status(400).json({ error: `TTL must be between ${MIN_TTL} and ${MAX_TTL} seconds` });
      return;
    }
    ttl = parsedTtl;
  }

  // Parse disposition parameter for Content-Disposition header
  const disposition = req.query.disposition as string | undefined;
  const rawFilename = keyValidation.validatedKey.split('/').pop() || 'download';
  const filename = sanitizeFilename(rawFilename);

  // Parse and validate contentType parameter for overriding S3 Content-Type
  const contentType = validateContentType(req.query.contentType as string | undefined);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: keyValidation.validatedKey,
    ...(versionId && { VersionId: versionId }),
    ...(disposition === 'inline' && { ResponseContentDisposition: 'inline' }),
    ...(disposition === 'attachment' && {
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }),
    ...(contentType && { ResponseContentType: contentType }),
  });

  try {
    const url = await getSignedUrl(client, command, { expiresIn: ttl });
    res.json({ url });
  } catch (error) {
    console.error('Failed to generate presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// GET /api/download/:connectionId/:bucket/object?key=
router.get('/:connectionId/:bucket/object', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  if (!bucket || !client) {
    console.error('Download object route missing S3 context:', {
      route: 'GET /api/download/:connectionId/:bucket/object',
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

  const versionId = typeof req.query.versionId === 'string'
    && req.query.versionId.trim()
    && !hasUnsafeChars(req.query.versionId)
    ? req.query.versionId
    : undefined;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: keyValidation.validatedKey,
    ...(versionId && { VersionId: versionId }),
  });

  try {
    const response = await client.send(command);
    const body = response.Body;
    if (!body) {
      res.status(500).json({ error: 'Missing response body' });
      return;
    }

    const rawFilename = keyValidation.validatedKey.split('/').pop() || 'download';
    const filename = sanitizeFilename(rawFilename);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (response.ContentType) {
      res.setHeader('Content-Type', response.ContentType);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
    if (typeof response.ContentLength === 'number') {
      res.setHeader('Content-Length', response.ContentLength.toString());
    }

    if (isNodeReadableStream(body)) {
      res.on('close', () => {
        if (!res.writableEnded) {
          body.destroy?.();
        }
      });
      body.on('error', (err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream object' });
          return;
        }
        res.end();
        console.error('Stream error while downloading object:', err);
      });
      body.pipe(res);
      return;
    }

    if (isWebReadableStream(body)) {
      await pipeWebStreamToResponse(body, res);
      return;
    }

    res.status(500).json({ error: 'Unsupported response body type' });
  } catch (error) {
    if (res.headersSent) {
      console.error('pipeWebStreamToResponse: failed to stream response', error);
      res.end();
      return;
    }
    if (isAccessDenied(error)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (isNotFound(error)) {
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    console.error('Failed to stream object:', error);
    res.status(500).json({ error: 'Failed to stream object' });
  }
});

export default router;
