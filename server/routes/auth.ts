import { Router, Request, Response } from 'express';
import {
  validateCredentials,
  createSession,
  deleteSession,
  getSession,
  S3Credentials,
} from '../middleware/auth.js';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { accessKeyId, secretAccessKey, region, bucket } = req.body;

  if (!accessKeyId || !secretAccessKey || !region || !bucket) {
    res.status(400).json({ error: 'Missing required credentials' });
    return;
  }

  const credentials: S3Credentials = {
    accessKeyId,
    secretAccessKey,
    region,
    bucket,
  };

  try {
    const isValid = await validateCredentials(credentials);
    if (!isValid) {
      res.status(401).json({ error: 'Invalid credentials or bucket not found' });
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
      region,
      bucket,
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
  });
});

export default router;
