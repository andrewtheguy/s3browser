import { Router, Response } from 'express';
import multer from 'multer';
import { Upload } from '@aws-sdk/lib-storage';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

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

    if (!key) {
      res.status(400).json({ error: 'Object key is required' });
      return;
    }

    const session = req.session!;

    try {
      const uploadManager = new Upload({
        client: session.client,
        params: {
          Bucket: session.credentials.bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype || 'application/octet-stream',
        },
        queueSize: 4,
        partSize: 5 * 1024 * 1024, // 5MB parts
        leavePartsOnError: false,
      });

      await uploadManager.done();
      res.json({ success: true, key });
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: 'Failed to upload file' });
    }
  }
);

export default router;
