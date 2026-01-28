import { Router, Response } from 'express';
import {
  ListObjectsV2Command,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

interface S3Object {
  key: string;
  name: string;
  size?: number;
  lastModified?: string;
  isFolder: boolean;
  etag?: string;
}

function extractFileName(key: string): string {
  // Remove trailing slash for folders
  const cleanKey = key.endsWith('/') ? key.slice(0, -1) : key;
  // Get the last segment
  const segments = cleanKey.split('/');
  return segments[segments.length - 1] || cleanKey;
}

// GET /api/objects?prefix=&continuationToken=
router.get('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const prefix = (req.query.prefix as string) || '';
  const continuationToken = (req.query.continuationToken as string) || undefined;
  const session = req.session!;

  const command = new ListObjectsV2Command({
    Bucket: session.credentials.bucket,
    Prefix: prefix,
    Delimiter: '/',
    MaxKeys: 1000,
    ContinuationToken: continuationToken,
  });

  const response = await session.client.send(command);
  const objects: S3Object[] = [];

  // Add folders (CommonPrefixes)
  if (response.CommonPrefixes) {
    for (const prefixObj of response.CommonPrefixes) {
      if (prefixObj.Prefix) {
        objects.push({
          key: prefixObj.Prefix,
          name: extractFileName(prefixObj.Prefix),
          isFolder: true,
        });
      }
    }
  }

  // Add files (Contents)
  if (response.Contents) {
    for (const item of response.Contents) {
      if (item.Key && item.Key !== prefix) {
        objects.push({
          key: item.Key,
          name: extractFileName(item.Key),
          size: item.Size,
          lastModified: item.LastModified?.toISOString(),
          isFolder: false,
          etag: item.ETag,
        });
      }
    }
  }

  // Note: Objects are returned in S3's native order (typically lexicographic by key).
  // Sorting (folders first, then alphabetically) should be done client-side after
  // aggregating all pages via continuationToken, since per-page sorting would
  // produce inconsistent results when isTruncated is true.

  res.json({
    objects,
    continuationToken: response.NextContinuationToken,
    isTruncated: response.IsTruncated ?? false,
  });
});

// DELETE /api/objects/:key
router.delete('/*key', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  // Get the key from the URL path (everything after /api/objects/)
  const keyParam = req.params.key;
  const key = Array.isArray(keyParam) ? keyParam.join('/') : keyParam;

  if (!key) {
    res.status(400).json({ error: 'Object key is required' });
    return;
  }

  const session = req.session!;

  const command = new DeleteObjectCommand({
    Bucket: session.credentials.bucket,
    Key: key,
  });

  await session.client.send(command);
  res.json({ success: true });
});

// POST /api/objects/folder
router.post('/folder', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { path } = req.body;

  if (typeof path !== 'string' || path.trim().length === 0) {
    res.status(400).json({ error: 'Folder path must be a non-empty string' });
    return;
  }

  const session = req.session!;
  const folderPath = path.endsWith('/') ? path : `${path}/`;

  const command = new PutObjectCommand({
    Bucket: session.credentials.bucket,
    Key: folderPath,
    Body: '',
    ContentType: 'application/x-directory',
  });

  await session.client.send(command);
  res.json({ success: true, key: folderPath });
});

export default router;
