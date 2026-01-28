import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { Upload } from '@aws-sdk/lib-storage';
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { UPLOAD_CONFIG } from '../config/upload.js';

// Whitelist: alphanumeric, hyphen, underscore, period, forward slash
const VALID_KEY_PATTERN = /^[a-zA-Z0-9\-_./]+$/;

function validateAndSanitizeKey(key: string, sessionId: string): { valid: false; error: string } | { valid: true; sanitizedKey: string } {
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

  // Scope key to session namespace to prevent cross-user writes
  const sanitizedKey = `${sessionId}/${normalized}`;

  return { valid: true, sanitizedKey };
}

const router = Router();

// Configure multer for memory storage (legacy endpoint)
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB max file size for legacy upload

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

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

const uploadTracker = new Map<string, UploadTrackingData>();

// Clean up old tracking entries (older than 24 hours)
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  for (const [trackingKey, data] of uploadTracker) {
    if (now - data.createdAt > maxAge) {
      uploadTracker.delete(trackingKey);
    }
  }
}, 60 * 60 * 1000); // Check every hour

// All routes require authentication
router.use(authMiddleware);

// POST /api/upload (legacy proxy-based upload)
router.post(
  '/',
  upload.single('file'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const file = req.file;
    const key = req.body.key;

    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const session = req.session!;
    const sessionId = req.sessionId!;

    const keyValidation = validateAndSanitizeKey(key, sessionId);
    if (!keyValidation.valid) {
      res.status(400).json({ error: keyValidation.error });
      return;
    }

    const uploadManager = new Upload({
      client: session.client,
      params: {
        Bucket: session.credentials.bucket,
        Key: keyValidation.sanitizedKey,
        Body: file.buffer,
        ContentType: file.mimetype || 'application/octet-stream',
      },
      queueSize: 4,
      partSize: 5 * 1024 * 1024, // 5MB parts
      leavePartsOnError: false,
    });

    await uploadManager.done();
    res.json({ success: true, key: keyValidation.sanitizedKey });
  }
);

// POST /api/upload/presign-single - Get presigned URL for small file upload
router.post('/presign-single', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { key, contentType, fileSize } = req.body;
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

  const keyValidation = validateAndSanitizeKey(key, sessionId);
  if (!keyValidation.valid) {
    res.status(400).json({ error: keyValidation.error });
    return;
  }

  const command = new PutObjectCommand({
    Bucket: session.credentials.bucket,
    Key: keyValidation.sanitizedKey,
    ContentType: contentType || 'application/octet-stream',
  });

  const url = await getSignedUrl(session.client, command, {
    expiresIn: UPLOAD_CONFIG.PRESIGN_EXPIRY,
  });

  res.json({
    url,
    key: keyValidation.sanitizedKey,
  });
});

// POST /api/upload/initiate - Start a multipart upload
router.post('/initiate', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { key, contentType, fileSize } = req.body;
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

  const keyValidation = validateAndSanitizeKey(key, sessionId);
  if (!keyValidation.valid) {
    res.status(400).json({ error: keyValidation.error });
    return;
  }

  const command = new CreateMultipartUploadCommand({
    Bucket: session.credentials.bucket,
    Key: keyValidation.sanitizedKey,
    ContentType: contentType || 'application/octet-stream',
  });

  const response = await session.client.send(command);
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

// POST /api/upload/presign - Get presigned URL for a specific part
router.post('/presign', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { uploadId, key, partNumber } = req.body;
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

  if (typeof partNumber !== 'number' || partNumber < 1) {
    res.status(400).json({ error: 'Valid partNumber (>= 1) is required' });
    return;
  }

  // Validate against tracked upload
  const trackingKey = `${sessionId}:${uploadId}`;
  const tracked = uploadTracker.get(trackingKey);

  if (!tracked) {
    res.status(404).json({ error: 'Upload not found or expired' });
    return;
  }

  if (partNumber > tracked.totalParts) {
    res.status(400).json({ error: `Part number ${partNumber} exceeds total parts ${tracked.totalParts}` });
    return;
  }

  const command = new UploadPartCommand({
    Bucket: session.credentials.bucket,
    Key: tracked.sanitizedKey,
    UploadId: uploadId,
    PartNumber: partNumber,
  });

  const url = await getSignedUrl(session.client, command, {
    expiresIn: UPLOAD_CONFIG.PRESIGN_EXPIRY,
  });

  res.json({ url, partNumber });
});

// POST /api/upload/complete - Complete a multipart upload
router.post('/complete', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { uploadId, key, parts } = req.body;
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

  // Validate parts format
  for (const part of parts) {
    if (typeof part.partNumber !== 'number' || typeof part.etag !== 'string') {
      res.status(400).json({ error: 'Each part must have partNumber and etag' });
      return;
    }
  }

  // Validate against tracked upload
  const trackingKey = `${sessionId}:${uploadId}`;
  const tracked = uploadTracker.get(trackingKey);

  if (!tracked) {
    res.status(404).json({ error: 'Upload not found or expired' });
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

  await session.client.send(command);

  // Clean up tracking
  uploadTracker.delete(trackingKey);

  res.json({ success: true, key: tracked.sanitizedKey });
});

// POST /api/upload/abort - Abort a multipart upload
router.post('/abort', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { uploadId, key } = req.body;
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
    const keyValidation = validateAndSanitizeKey(key, sessionId);
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
  } finally {
    // Clean up tracking regardless of success/failure
    uploadTracker.delete(trackingKey);
  }

  res.json({ success: true });
});

export default router;
