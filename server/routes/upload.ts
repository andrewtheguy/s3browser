import { Router, Response, default as express } from 'express';
import path from 'path';
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { authMiddleware, requireBucket, AuthenticatedRequest } from '../middleware/auth.js';
import { UPLOAD_CONFIG } from '../config/upload.js';

// Whitelist: alphanumeric, hyphen, underscore, period, forward slash
const VALID_KEY_PATTERN = /^[a-zA-Z0-9\-_./]+$/;

function validateAndSanitizeKey(key: string): { valid: false; error: string } | { valid: true; sanitizedKey: string } {
  // Reject empty keys
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Object key is required' };
  }

  // Reject backslashes
  if (key.includes('\\')) {
    return { valid: false, error: 'Invalid character in key: backslash not allowed' };
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

  // Validate against whitelist pattern
  if (!VALID_KEY_PATTERN.test(normalized)) {
    return { valid: false, error: 'Invalid characters in key' };
  }

  return { valid: true, sanitizedKey: normalized };
}

const router = Router();

// In-memory tracking for multipart uploads
// Key: `${sessionId}:${uploadId}`
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

// All routes require authentication and a bucket to be selected
router.use(authMiddleware);
router.use(requireBucket);

// POST /api/upload/single - Proxy single file upload through server to S3
router.post(
  '/single',
  express.raw({ limit: '10mb', type: '*/*' }),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const key = req.query.key as string;
    const session = req.session!;

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

    const command = new PutObjectCommand({
      Bucket: session.credentials.bucket,
      Key: keyValidation.sanitizedKey,
      Body: req.body as Buffer,
      ContentType: contentType,
    });

    try {
      await session.client.send(command);
      res.json({ success: true, key: keyValidation.sanitizedKey });
    } catch (error) {
      console.error('Single file upload failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: 'Single file upload failed', details: message });
    }
  }
);

// POST /api/upload/part - Proxy multipart part upload through server to S3
router.post(
  '/part',
  express.raw({ limit: '15mb', type: '*/*' }),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const uploadId = req.query.uploadId as string;
    const partNumber = req.query.partNumber as string;
    const key = req.query.key as string;
    const session = req.session!;
    const sessionId = req.sessionId!;

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
    const trackingKey = `${sessionId}:${uploadId}`;
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

    const command = new UploadPartCommand({
      Bucket: session.credentials.bucket,
      Key: tracked.sanitizedKey,
      UploadId: uploadId,
      PartNumber: partNum,
      Body: req.body as Buffer,
    });

    try {
      const result = await session.client.send(command);
      res.json({ etag: result.ETag });
    } catch (error) {
      console.error('Upload part failed:', { key: tracked.sanitizedKey, uploadId, partNum, error });
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: 'Upload part failed', details: message });
    }
  }
);

// POST /api/upload/initiate - Start a multipart upload
router.post('/initiate', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as InitiateUploadBody;
  const { key, contentType, fileSize } = body;
  const session = req.session!;
  const sessionId = req.sessionId!;

  if (!key || typeof key !== 'string') {
    res.status(400).json({ error: 'Key is required' });
    return;
  }

  if (typeof fileSize !== 'number' || fileSize <= 0) {
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
    Bucket: session.credentials.bucket,
    Key: keyValidation.sanitizedKey,
    ContentType: contentType || 'application/octet-stream',
  });

  let response;
  try {
    response = await session.client.send(command);
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
  const trackingKey = `${sessionId}:${uploadId}`;
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

// POST /api/upload/complete - Complete a multipart upload
router.post('/complete', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as CompleteUploadBody;
  const { uploadId, key, parts } = body;
  const session = req.session!;
  const sessionId = req.sessionId!;

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
  const trackingKey = `${sessionId}:${uploadId}`;
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
    Bucket: session.credentials.bucket,
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
    await session.client.send(command);
    // Clean up tracking only on success
    uploadTracker.delete(trackingKey);
    res.json({ success: true, key: tracked.sanitizedKey });
  } catch (error) {
    console.error('Failed to complete multipart upload:', error);
    // Attempt to abort the multipart upload on S3
    try {
      const abortCommand = new AbortMultipartUploadCommand({
        Bucket: session.credentials.bucket,
        Key: tracked.sanitizedKey,
        UploadId: uploadId,
      });
      await session.client.send(abortCommand);
    } catch (abortError) {
      console.error('Failed to abort multipart upload after completion failure:', abortError);
    }
    // Clean up tracking after abort attempt
    uploadTracker.delete(trackingKey);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: 'Failed to complete multipart upload', details: message });
  }
});

// POST /api/upload/abort - Abort a multipart upload
router.post('/abort', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as AbortUploadBody;
  const { uploadId, key } = body;
  const session = req.session!;
  const sessionId = req.sessionId!;

  if (!uploadId || typeof uploadId !== 'string') {
    res.status(400).json({ error: 'uploadId is required' });
    return;
  }

  if (!key || typeof key !== 'string') {
    res.status(400).json({ error: 'Key is required' });
    return;
  }

  // Get tracked upload for the sanitized key
  const trackingKey = `${sessionId}:${uploadId}`;
  const tracked = uploadTracker.get(trackingKey);

  // Use tracked key if available, otherwise validate the provided key
  let sanitizedKey: string;
  if (tracked) {
    sanitizedKey = tracked.sanitizedKey;
  } else {
    const keyValidation = validateAndSanitizeKey(key);
    if (!keyValidation.valid) {
      res.status(400).json({ error: keyValidation.error });
      return;
    }
    sanitizedKey = keyValidation.sanitizedKey;
  }

  const command = new AbortMultipartUploadCommand({
    Bucket: session.credentials.bucket,
    Key: sanitizedKey,
    UploadId: uploadId,
  });

  try {
    await session.client.send(command);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to abort multipart upload:', error);
    res.status(500).json({ success: false, error: 'Failed to abort multipart upload' });
  } finally {
    // Clean up tracking regardless of success/failure
    uploadTracker.delete(trackingKey);
  }
});

export default router;
