import { Router, Response } from 'express';
import {
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { s3Middleware, requireBucket, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

interface FolderRequestBody {
  path?: string;
}

interface BatchDeleteRequestBody {
  keys?: string[];
}

interface BatchDeleteResponse {
  deleted: string[];
  errors: Array<{ key: string; message: string }>;
}

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

// All routes use s3Middleware which checks auth and creates S3 client from connectionId
// Routes: /api/objects/:connectionId/:bucket/...

// GET /api/objects/:connectionId/:bucket?prefix=&continuationToken=
router.get('/:connectionId/:bucket', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const prefix = (req.query.prefix as string) || '';
  const continuationToken = (req.query.continuationToken as string) || undefined;

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check (middleware guarantees these exist)
  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    Delimiter: '/',
    MaxKeys: 1000,
    ContinuationToken: continuationToken,
  });

  const response = await client.send(command);
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

// DELETE /api/objects/:connectionId/:bucket/*key
router.delete('/:connectionId/:bucket/*key', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  // Get the key from the URL path (everything after /api/objects/:connectionId/:bucket/)
  const keyParam = req.params.key;
  const key = Array.isArray(keyParam) ? keyParam.join('/') : keyParam;

  if (!key) {
    res.status(400).json({ error: 'Object key is required' });
    return;
  }

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check (middleware guarantees these exist)
  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  // If deleting a folder (key ends with /), check if it's empty first
  if (key.endsWith('/')) {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: key,
      MaxKeys: 2, // We only need to know if there's more than the folder marker
    });

    const listResponse = await client.send(listCommand);
    const contents = listResponse.Contents || [];

    // Filter out the folder marker itself
    const otherObjects = contents.filter((obj) => obj.Key !== key);

    if (otherObjects.length > 0) {
      res.status(400).json({ error: 'Cannot delete folder: folder is not empty' });
      return;
    }
  }

  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  await client.send(command);
  res.json({ success: true });
});

// POST /api/objects/:connectionId/:bucket/batch-delete
router.post('/:connectionId/:bucket/batch-delete', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as BatchDeleteRequestBody;
  const { keys } = body;

  if (!Array.isArray(keys) || keys.length === 0) {
    res.status(400).json({ error: 'Keys must be a non-empty array' });
    return;
  }

  // Filter out folder keys (ending with /) and empty/whitespace-only strings
  const fileKeys = keys.filter((key) => typeof key === 'string' && key.trim().length > 0 && !key.endsWith('/'));

  if (fileKeys.length === 0) {
    res.status(400).json({ error: 'No valid file keys provided' });
    return;
  }

  // AWS S3 DeleteObjects supports up to 1000 keys per request
  if (fileKeys.length > 1000) {
    res.status(400).json({ error: 'Cannot delete more than 1000 objects at once' });
    return;
  }

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check (middleware guarantees these exist)
  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const command = new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: {
      Objects: fileKeys.map((key) => ({ Key: key })),
      Quiet: false,
    },
  });

  const response = await client.send(command);

  const result: BatchDeleteResponse = {
    deleted: response.Deleted
      ?.filter((d): d is { Key: string } => typeof d.Key === 'string')
      .map((d) => d.Key) ?? [],
    errors: response.Errors
      ?.filter((e): e is { Key: string; Message?: string } => typeof e.Key === 'string')
      .map((e) => ({
        key: e.Key,
        message: e.Message ?? 'Unknown error',
      })) ?? [],
  };

  res.json(result);
});

// POST /api/objects/:connectionId/:bucket/folder
router.post('/:connectionId/:bucket/folder', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as FolderRequestBody;
  const { path } = body;

  if (typeof path !== 'string' || path.trim().length === 0) {
    res.status(400).json({ error: 'Folder path must be a non-empty string' });
    return;
  }

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check (middleware guarantees these exist)
  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const folderPath = path.endsWith('/') ? path : `${path}/`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: folderPath,
    Body: '',
    ContentType: 'application/x-directory',
  });

  await client.send(command);
  res.json({ success: true, key: folderPath });
});

export default router;
