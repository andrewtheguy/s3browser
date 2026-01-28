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

  try {
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

    // Sort: folders first, then files, alphabetically
    objects.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({
      objects,
      continuationToken: response.NextContinuationToken,
      isTruncated: response.IsTruncated ?? false,
    });
  } catch (error) {
    console.error('List objects error:', error);
    res.status(500).json({ error: 'Failed to list objects' });
  }
});

// DELETE /api/objects/:key
router.delete('/*', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  // Get the key from the URL path (everything after /api/objects/)
  const key = req.params[0];

  if (!key) {
    res.status(400).json({ error: 'Object key is required' });
    return;
  }

  const session = req.session!;

  try {
    const command = new DeleteObjectCommand({
      Bucket: session.credentials.bucket,
      Key: key,
    });

    await session.client.send(command);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete object error:', error);
    res.status(500).json({ error: 'Failed to delete object' });
  }
});

// POST /api/objects/folder
router.post('/folder', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { path } = req.body;

  if (!path) {
    res.status(400).json({ error: 'Folder path is required' });
    return;
  }

  const session = req.session!;
  const folderPath = path.endsWith('/') ? path : `${path}/`;

  try {
    const command = new PutObjectCommand({
      Bucket: session.credentials.bucket,
      Key: folderPath,
      Body: '',
      ContentType: 'application/x-directory',
    });

    await session.client.send(command);
    res.json({ success: true, key: folderPath });
  } catch (error) {
    console.error('Create folder error:', error);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

export default router;
