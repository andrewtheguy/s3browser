import { Router, Response } from 'express';
import path from 'path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

// Whitelist: alphanumeric, hyphen, underscore, period, forward slash
const VALID_KEY_PATTERN = /^[a-zA-Z0-9\-_./]+$/;

function validateKey(key: unknown, sessionId: string): { valid: false; error: string } | { valid: true; validatedKey: string } {
  // Handle array case - reject if multiple values
  if (Array.isArray(key)) {
    return { valid: false, error: 'Multiple key values not allowed' };
  }

  // Ensure key is a string
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

  // Enforce user-scoped prefix
  const expectedPrefix = `${sessionId}/`;
  if (!normalized.startsWith(expectedPrefix)) {
    return { valid: false, error: 'Access denied: key outside user scope' };
  }

  return { valid: true, validatedKey: normalized };
}

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/download/url?key=
router.get('/url', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  // Defensive check: authMiddleware should populate these, but verify to avoid runtime errors
  if (!req.session || !req.sessionId) {
    console.warn('Auth check failed in download route:', {
      hasSession: !!req.session,
      hasSessionId: !!req.sessionId,
      partialSessionId: req.sessionId ? req.sessionId.slice(0, 8) + '...' : undefined,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const session = req.session;
  const sessionId = req.sessionId;

  const keyValidation = validateKey(req.query.key, sessionId);
  if (!keyValidation.valid) {
    res.status(400).json({ error: keyValidation.error });
    return;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: session.credentials.bucket,
      Key: keyValidation.validatedKey,
    });

    // Generate presigned URL with 1 hour expiry
    const url = await getSignedUrl(session.client, command, { expiresIn: 3600 });
    res.json({ url });
  } catch (error) {
    console.error('Get download URL error:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

export default router;
