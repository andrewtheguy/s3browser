import { Router, Response } from 'express';
import path from 'path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { authMiddleware, requireBucket, AuthenticatedRequest } from '../middleware/auth.js';

// Whitelist: alphanumeric, hyphen, underscore, period, forward slash
const VALID_KEY_PATTERN = /^[a-zA-Z0-9\-_./]+$/;

function validateKey(key: unknown): { valid: false; error: string } | { valid: true; validatedKey: string } {
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

  return { valid: true, validatedKey: normalized };
}

const router = Router();

// All routes require authentication and a bucket to be selected
router.use(authMiddleware);
router.use(requireBucket);

// GET /api/download/url?key=
router.get('/url', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  // Defensive check: authMiddleware should populate these, but verify to avoid runtime errors
  const session = req.session;
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // Verify session has expected shape with credentials and client
  if (!session.credentials || !session.client) {
    res.status(401).json({ error: 'Invalid session state' });
    return;
  }

  // Verify bucket is defined in credentials
  if (!session.credentials.bucket) {
    res.status(400).json({ error: 'No bucket configured for this session' });
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
    Bucket: session.credentials.bucket,
    Key: keyValidation.validatedKey,
  });

  try {
    const url = await getSignedUrl(session.client, command, { expiresIn: ttl });
    res.json({ url });
  } catch (error) {
    console.error('Failed to generate presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

export default router;
