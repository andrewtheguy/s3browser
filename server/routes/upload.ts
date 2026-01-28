import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { Upload } from '@aws-sdk/lib-storage';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

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

  // Normalize path and check for directory traversal
  const normalized = path.posix.normalize(key);
  if (normalized.startsWith('..') || normalized.includes('/..') || normalized.includes('../')) {
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

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB max file size
  },
});

// All routes require authentication
router.use(authMiddleware);

// POST /api/upload
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

    try {
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
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: 'Failed to upload file' });
    }
  }
);

export default router;
