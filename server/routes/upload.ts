import { Router, Response, default as express } from 'express';
import path from 'path';
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { s3Middleware, requireBucket, AuthenticatedRequest } from '../middleware/auth.js';
import { UPLOAD_CONFIG } from '../config/upload.js';

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

function validateAndSanitizeKey(key: string): { valid: false; error: string } | { valid: true; sanitizedKey: string } {
  // Reject empty keys
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

  return { valid: true, sanitizedKey: normalized };
}

interface NodeReadableStreamLike {
  on: (event: 'data' | 'end' | 'error', handler: (chunk?: unknown) => void) => void;
  pause?: () => void;
}

interface WebReadableStreamReaderLike {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?: () => void;
}

interface WebReadableStreamLike {
  getReader: () => WebReadableStreamReaderLike;
}

function isNodeReadableStream(value: unknown): value is NodeReadableStreamLike {
  return typeof value === 'object' &&
    value !== null &&
    'on' in value &&
    typeof (value as { on?: unknown }).on === 'function';
}

function isWebReadableStream(value: unknown): value is WebReadableStreamLike {
  return typeof value === 'object' &&
    value !== null &&
    'getReader' in value &&
    typeof (value as { getReader?: unknown }).getReader === 'function';
}

async function readNodeStream(stream: NodeReadableStreamLike): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.pause?.();
  return await new Promise<Buffer>((resolve, reject) => {
    stream.on('data', (chunk) => {
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
        return;
      }
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
        return;
      }
      if (chunk && typeof chunk === 'object') {
        chunks.push(Buffer.from(JSON.stringify(chunk)));
        return;
      }
      if (typeof chunk === 'number' || typeof chunk === 'boolean' || typeof chunk === 'bigint') {
        chunks.push(Buffer.from(String(chunk)));
      }
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (error) => {
      reject(error instanceof Error ? error : new Error('Failed to read stream'));
    });
  });
}

async function readWebStream(stream: WebReadableStreamLike): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value) {
      chunks.push(result.value);
    }
  }
  reader.releaseLock?.();
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function resolveBodyBuffer(req: AuthenticatedRequest): Promise<Buffer> {
  const body = req.body as unknown;
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  if (isNodeReadableStream(body)) {
    return await readNodeStream(body);
  }
  if (isWebReadableStream(body)) {
    return await readWebStream(body);
  }
  if (body && typeof body === 'object') {
    return Buffer.from(JSON.stringify(body));
  }
  if (isNodeReadableStream(req)) {
    return await readNodeStream(req);
  }
  return Buffer.from('');
}

const router = Router();

// In-memory tracking for multipart uploads
// Key: `${connectionId}:${bucket}:${uploadId}`
interface UploadTrackingData {
  key: string;
  sanitizedKey: string;
  totalParts: number;
  contentType: string;
  createdAt: number;
  fileSize: number;
}

// Request body interfaces
interface InitiateUploadBody {
  key?: string;
  contentType?: string;
  fileSize?: number;
}

interface CompletePart {
  partNumber: number;
  etag: string;
}

interface CompleteUploadBody {
  uploadId?: string;
  key?: string;
  parts?: CompletePart[];
}

interface AbortUploadBody {
  uploadId?: string;
  key?: string;
}

const uploadTracker = new Map<string, UploadTrackingData>();

// Clean up old tracking entries (older than 24 hours)
const uploadTrackerCleanupInterval = setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  for (const [trackingKey, data] of uploadTracker) {
    if (now - data.createdAt > maxAge) {
      uploadTracker.delete(trackingKey);
    }
  }
}, 60 * 60 * 1000); // Check every hour

// Cleanup function for tests and hot reloads
export function cleanupUploadTracker(): void {
  clearInterval(uploadTrackerCleanupInterval);
  uploadTracker.clear();
}

// All routes use s3Middleware which checks auth and creates S3 client from connectionId
// Routes: /api/upload/:connectionId/:bucket/...

// POST /api/upload/:connectionId/:bucket/single - Proxy single file upload through server to S3
router.post(
  '/:connectionId/:bucket/single',
  s3Middleware,
  requireBucket,
  express.raw({ limit: '10mb', type: '*/*' }),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const key = req.query.key as string;
    const bucket = req.s3Credentials?.bucket;
    const client = req.s3Client;

    // Defensive check (middleware guarantees these exist)
    if (!bucket || !client) {
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    if (!key || typeof key !== 'string') {
      res.status(400).json({ error: 'Key query parameter is required' });
      return;
    }

    const keyValidation = validateAndSanitizeKey(key);
    if (!keyValidation.valid) {
      res.status(400).json({ error: keyValidation.error });
      return;
    }

    const contentType = req.headers['content-type'] || 'application/octet-stream';

    try {
      const bodyBuffer = await resolveBodyBuffer(req);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: keyValidation.sanitizedKey,
        Body: bodyBuffer,
        ContentType: contentType,
      });
      await client.send(command);
      res.json({ success: true, key: keyValidation.sanitizedKey });
    } catch (error) {
      console.error('Single file upload failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: 'Single file upload failed', details: message });
    }
  }
);

// POST /api/upload/:connectionId/:bucket/part - Proxy multipart part upload through server to S3
router.post(
  '/:connectionId/:bucket/part',
  s3Middleware,
  requireBucket,
  express.raw({ limit: '15mb', type: '*/*' }),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const uploadId = req.query.uploadId as string;
    const partNumber = req.query.partNumber as string;
    const key = req.query.key as string;
    const connectionId = req.connectionId;
    const bucket = req.s3Credentials?.bucket;
    const client = req.s3Client;

    // Defensive check (middleware guarantees these exist)
    if (!bucket || !client || !connectionId) {
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    if (!uploadId || typeof uploadId !== 'string') {
      res.status(400).json({ error: 'uploadId query parameter is required' });
      return;
    }

    if (!partNumber || isNaN(Number(partNumber)) || Number(partNumber) < 1) {
      res.status(400).json({ error: 'Valid partNumber query parameter (>= 1) is required' });
      return;
    }

    if (!key || typeof key !== 'string') {
      res.status(400).json({ error: 'key query parameter is required' });
      return;
    }

    // Validate against tracked upload
    const trackingKey = `${connectionId}:${bucket}:${uploadId}`;
    const tracked = uploadTracker.get(trackingKey);

    if (!tracked) {
      res.status(404).json({ error: 'Upload not found or expired' });
      return;
    }

    // Validate key matches the tracked upload
    if (key !== tracked.sanitizedKey) {
      res.status(403).json({ error: 'Key does not match the upload' });
      return;
    }

    const partNum = Number(partNumber);
    if (partNum > tracked.totalParts) {
      res.status(400).json({ error: `Part number ${partNum} exceeds total parts ${tracked.totalParts}` });
      return;
    }

    try {
      const bodyBuffer = await resolveBodyBuffer(req);
      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: tracked.sanitizedKey,
        UploadId: uploadId,
        PartNumber: partNum,
        Body: bodyBuffer,
      });
      const result = await client.send(command);
      res.json({ etag: result.ETag });
    } catch (error) {
      console.error('Upload part failed:', { key: tracked.sanitizedKey, uploadId, partNum, error });
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: 'Upload part failed', details: message });
    }
  }
);

// POST /api/upload/:connectionId/:bucket/initiate - Start a multipart upload
router.post('/:connectionId/:bucket/initiate', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as InitiateUploadBody;
  const { key, contentType, fileSize } = body;
  const connectionId = req.connectionId;
  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check (middleware guarantees these exist)
  if (!bucket || !client || !connectionId) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  if (!key || typeof key !== 'string') {
    res.status(400).json({ error: 'Key is required' });
    return;
  }

  if (typeof fileSize !== 'number' || !Number.isInteger(fileSize) || fileSize <= 0) {
    res.status(400).json({ error: 'Valid fileSize is required' });
    return;
  }

  if (fileSize > UPLOAD_CONFIG.MAX_FILE_SIZE) {
    res.status(400).json({ error: `File size exceeds maximum of ${UPLOAD_CONFIG.MAX_FILE_SIZE} bytes` });
    return;
  }

  const keyValidation = validateAndSanitizeKey(key);
  if (!keyValidation.valid) {
    res.status(400).json({ error: keyValidation.error });
    return;
  }

  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: keyValidation.sanitizedKey,
    ContentType: contentType || 'application/octet-stream',
  });

  let response;
  try {
    response = await client.send(command);
  } catch (error) {
    console.error('Failed to initiate multipart upload:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to initiate multipart upload', details: message });
    return;
  }

  const uploadId = response.UploadId;

  if (!uploadId) {
    res.status(500).json({ error: 'Failed to initiate multipart upload' });
    return;
  }

  // Calculate total parts
  const totalParts = Math.ceil(fileSize / UPLOAD_CONFIG.PART_SIZE);

  // Track the upload
  const trackingKey = `${connectionId}:${bucket}:${uploadId}`;
  uploadTracker.set(trackingKey, {
    key,
    sanitizedKey: keyValidation.sanitizedKey,
    totalParts,
    contentType: contentType || 'application/octet-stream',
    createdAt: Date.now(),
    fileSize,
  });

  res.json({
    uploadId,
    key: keyValidation.sanitizedKey,
    totalParts,
    partSize: UPLOAD_CONFIG.PART_SIZE,
  });
});

// POST /api/upload/:connectionId/:bucket/complete - Complete a multipart upload
router.post('/:connectionId/:bucket/complete', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as CompleteUploadBody;
  const { uploadId, key, parts } = body;
  const connectionId = req.connectionId;
  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check (middleware guarantees these exist)
  if (!bucket || !client || !connectionId) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  if (!uploadId || typeof uploadId !== 'string') {
    res.status(400).json({ error: 'uploadId is required' });
    return;
  }

  if (!key || typeof key !== 'string') {
    res.status(400).json({ error: 'Key is required' });
    return;
  }

  if (!Array.isArray(parts) || parts.length === 0) {
    res.status(400).json({ error: 'Parts array is required' });
    return;
  }

  // Validate parts format - runtime check since body could have incorrect data
  const isValidParts = parts.every(
    (part): part is CompletePart =>
      typeof part === 'object' &&
      part !== null &&
      typeof part.partNumber === 'number' &&
      typeof part.etag === 'string'
  );

  if (!isValidParts) {
    res.status(400).json({ error: 'Each part must have partNumber and etag' });
    return;
  }

  // Validate against tracked upload
  const trackingKey = `${connectionId}:${bucket}:${uploadId}`;
  const tracked = uploadTracker.get(trackingKey);

  if (!tracked) {
    res.status(404).json({ error: 'Upload not found or expired' });
    return;
  }

  // Validate key matches the tracked upload
  if (key !== tracked.sanitizedKey) {
    res.status(403).json({ error: 'Key does not match the upload' });
    return;
  }

  const command = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: tracked.sanitizedKey,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts
        .sort((a: { partNumber: number }, b: { partNumber: number }) => a.partNumber - b.partNumber)
        .map((p: { partNumber: number; etag: string }) => ({
          PartNumber: p.partNumber,
          ETag: p.etag,
        })),
    },
  });

  try {
    await client.send(command);
    // Clean up tracking only on success
    uploadTracker.delete(trackingKey);
    res.json({ success: true, key: tracked.sanitizedKey });
  } catch (error) {
    console.error('Failed to complete multipart upload:', error);
    // Attempt to abort the multipart upload on S3
    try {
      const abortCommand = new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: tracked.sanitizedKey,
        UploadId: uploadId,
      });
      await client.send(abortCommand);
    } catch (abortError) {
      console.error('Failed to abort multipart upload after completion failure:', abortError);
    }
    // Clean up tracking after abort attempt
    uploadTracker.delete(trackingKey);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: 'Failed to complete multipart upload', details: message });
  }
});

// POST /api/upload/:connectionId/:bucket/abort - Abort a multipart upload
router.post('/:connectionId/:bucket/abort', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as AbortUploadBody;
  const { uploadId, key } = body;
  const connectionId = req.connectionId;
  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check (middleware guarantees these exist)
  if (!bucket || !client || !connectionId) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  if (!uploadId || typeof uploadId !== 'string') {
    res.status(400).json({ error: 'uploadId is required' });
    return;
  }

  if (!key || typeof key !== 'string') {
    res.status(400).json({ error: 'Key is required' });
    return;
  }

  // Get tracked upload for the sanitized key
  const trackingKey = `${connectionId}:${bucket}:${uploadId}`;
  const tracked = uploadTracker.get(trackingKey);

  // Validate the provided key
  const keyValidation = validateAndSanitizeKey(key);
  if (!keyValidation.valid) {
    res.status(400).json({ error: keyValidation.error });
    return;
  }

  // If tracked, verify the key matches
  let sanitizedKey: string;
  if (tracked) {
    if (keyValidation.sanitizedKey !== tracked.sanitizedKey) {
      res.status(400).json({ error: 'Key does not match the upload' });
      return;
    }
    sanitizedKey = tracked.sanitizedKey;
  } else {
    sanitizedKey = keyValidation.sanitizedKey;
  }

  const command = new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: sanitizedKey,
    UploadId: uploadId,
  });

  try {
    await client.send(command);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to abort multipart upload:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: 'Failed to abort multipart upload', details: message });
  } finally {
    // Clean up tracking regardless of success/failure
    uploadTracker.delete(trackingKey);
  }
});

export default router;
