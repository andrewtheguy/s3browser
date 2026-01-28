import { Router, Request, Response } from 'express';
import {
  validateCredentials,
  createSession,
  deleteSession,
  getSession,
  getBucketRegion,
  S3Credentials,
  authMiddleware,
  AuthenticatedRequest,
  listUserBuckets,
  updateSessionBucket,
  validateBucket,
} from '../middleware/auth.js';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { accessKeyId, secretAccessKey, region, bucket, endpoint } = req.body;

  if (!accessKeyId || !secretAccessKey) {
    res.status(400).json({ error: 'Missing required credentials' });
    return;
  }

  // If bucket is provided, use existing flow with region detection
  // If no bucket, use a default region (us-east-1) or provided region
  let detectedRegion = region;

  if (bucket) {
    // Auto-detect region from bucket if not provided
    if (!detectedRegion) {
      try {
        detectedRegion = await getBucketRegion(accessKeyId, secretAccessKey, bucket, endpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to detect region';
        res.status(400).json({ error: message });
        return;
      }
    }
  } else {
    // No bucket provided - use default region if not specified
    detectedRegion = detectedRegion || 'us-east-1';
  }

  const credentials: S3Credentials = {
    accessKeyId,
    secretAccessKey,
    region: detectedRegion,
    bucket: bucket || undefined,
    endpoint: endpoint || undefined,
  };

  // Only validate credentials with bucket if bucket is provided
  if (bucket) {
    const validation = await validateCredentials(credentials);
    if (!validation.valid) {
      res.status(401).json({ error: validation.error || 'Invalid credentials or bucket not found' });
      return;
    }
  }

  const sessionId = createSession(credentials);

  // Set HTTP-only cookie with 4 hour expiry
  res.cookie('sessionId', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 4 * 60 * 60 * 1000, // 4 hours
  });

  res.json({
    success: true,
    region: detectedRegion,
    bucket: bucket || null,
    endpoint: endpoint || undefined,
    requiresBucketSelection: !bucket,
  });
});

// POST /api/auth/logout
router.post('/logout', (req: Request, res: Response): void => {
  const sessionId = req.cookies?.sessionId;

  if (sessionId) {
    deleteSession(sessionId);
  }

  res.clearCookie('sessionId');
  res.json({ success: true });
});

// GET /api/auth/status
router.get('/status', (req: Request, res: Response): void => {
  const sessionId = req.cookies?.sessionId;

  if (!sessionId) {
    res.json({ authenticated: false });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.clearCookie('sessionId');
    res.json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    region: session.credentials.region,
    bucket: session.credentials.bucket || null,
    endpoint: session.credentials.endpoint,
    requiresBucketSelection: !session.credentials.bucket,
  });
});

// GET /api/auth/buckets - List available buckets for the authenticated user
router.get('/buckets', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const session = req.session!;

  try {
    const buckets = await listUserBuckets(session.client);
    res.json({ buckets });
  } catch (error: unknown) {
    console.error('Failed to list buckets:', error);

    if (error instanceof Error) {
      if (error.name === 'AccessDenied' || error.name === 'Forbidden') {
        res.status(403).json({
          error: 'Access denied',
          message: 'You do not have permission to list buckets. Please enter a bucket name manually.',
        });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to list buckets' });
  }
});

// POST /api/auth/select-bucket - Select a bucket for the current session
router.post('/select-bucket', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { bucket } = req.body;
  const session = req.session!;
  const sessionId = req.sessionId!;

  if (!bucket || typeof bucket !== 'string') {
    res.status(400).json({ error: 'Bucket name is required' });
    return;
  }

  // Validate that the bucket exists and is accessible
  const validation = await validateBucket(session.client, bucket);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error || 'Invalid bucket' });
    return;
  }

  // Update the session with the selected bucket
  const updated = updateSessionBucket(sessionId, bucket);
  if (!updated) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  res.json({
    success: true,
    bucket,
  });
});

export default router;
