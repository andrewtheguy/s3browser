import { Router, Response } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/download/url?key=
router.get('/url', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const key = req.query.key as string;

  if (!key) {
    res.status(400).json({ error: 'Object key is required' });
    return;
  }

  const session = req.session!;

  try {
    const command = new GetObjectCommand({
      Bucket: session.credentials.bucket,
      Key: key,
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
