import { Router, Request, Response } from 'express';
import {
  validateCredentials,
  createSession,
  deleteSession,
  getSession,
  getBucketRegion,
  S3Credentials,
} from '../middleware/auth.js';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { accessKeyId, secretAccessKey, region, bucket, endpoint } = req.body;

  if (!accessKeyId || !secretAccessKey || !bucket) {
    res.status(400).json({ error: 'Missing required credentials' });
    return;
  }

  try {
    // Auto-detect region if not provided
    let detectedRegion = region;
    if (!detectedRegion) {
      try {
        detectedRegion = await getBucketRegion(accessKeyId, secretAccessKey, bucket, endpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to detect region';
        res.status(400).json({ error: message });
        return;
      }
    }

    const credentials: S3Credentials = {
      accessKeyId,
      secretAccessKey,
      region: detectedRegion,
      bucket,
      endpoint: endpoint || undefined,
    };

    const validation = await validateCredentials(credentials);
    if (!validation.valid) {
      res.status(401).json({ error: validation.error || 'Invalid credentials or bucket not found' });
      return;
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
      bucket,
      endpoint: endpoint || undefined,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to authenticate' });
  }
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
    bucket: session.credentials.bucket,
    endpoint: session.credentials.endpoint,
  });
});

export default router;
