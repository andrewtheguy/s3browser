import { Router, Response } from 'express';
import {
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { s3Middleware, requireBucket, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// Maximum objects per batch operation (S3 DeleteObjects API limit is 1000).
// To support more than 1000 objects, batch operations would need to:
// 1. Chunk operations into groups of 1000
// 2. Use pagination (continuationToken) when listing objects for folder operations
// 3. Handle partial failures across chunks
const MAX_BATCH_OPERATIONS = 1000;

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

interface CopyRequestBody {
  sourceKey?: string;
  destinationKey?: string;
}

interface BatchCopyRequestBody {
  operations?: Array<{ sourceKey: string; destinationKey: string }>;
}

interface BatchCopyMoveResponse {
  successful: string[];
  errors: Array<{ sourceKey: string; message: string; destinationKey?: string }>;
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

function sanitizeFolderPath(path: string): { valid: true; path: string } | { valid: false; error: string } {
  // Trim whitespace
  let sanitized = path.trim();

  // Check for path traversal
  if (sanitized.includes('../')) {
    return { valid: false, error: 'Path traversal is not allowed' };
  }

  // Remove leading slashes
  sanitized = sanitized.replace(/^\/+/, '');

  // Collapse repeated slashes into single slash
  sanitized = sanitized.replace(/\/+/g, '/');

  // Remove trailing slash for processing, we'll add it back
  sanitized = sanitized.replace(/\/+$/, '');

  // Check if empty after sanitization
  if (sanitized.length === 0) {
    return { valid: false, error: 'Folder path cannot be empty' };
  }

  // Check for empty segments (would result from paths like "a//b" after collapse, but we handle that above)
  const segments = sanitized.split('/');
  if (segments.some(seg => seg.length === 0)) {
    return { valid: false, error: 'Folder path contains empty segments' };
  }

  // Add trailing slash for S3 folder convention
  const folderPath = sanitized + '/';

  // Validate byte length (S3 key limit is 1024 bytes)
  if (Buffer.byteLength(folderPath, 'utf8') > 1024) {
    return { valid: false, error: 'Folder path exceeds maximum length of 1024 bytes' };
  }

  return { valid: true, path: folderPath };
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

// DELETE /api/objects/:connectionId/:bucket?key=...
router.delete('/:connectionId/:bucket', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const key = req.query.key as string | undefined;

  if (!key) {
    res.status(400).json({ error: 'Object key is required' });
    return;
  }

  const keyValidation = validateKey(key);
  if (!keyValidation.valid) {
    res.status(400).json({ error: keyValidation.error });
    return;
  }

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check (middleware guarantees these exist)
  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
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
  if (fileKeys.length > MAX_BATCH_OPERATIONS) {
    res.status(400).json({ error: `Cannot delete more than ${MAX_BATCH_OPERATIONS} objects at once` });
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

  if (typeof path !== 'string') {
    res.status(400).json({ error: 'Folder path must be a string' });
    return;
  }

  const sanitizeResult = sanitizeFolderPath(path);
  if (!sanitizeResult.valid) {
    res.status(400).json({ error: sanitizeResult.error });
    return;
  }

  const folderPath = sanitizeResult.path;

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  // Defensive check (middleware guarantees these exist)
  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: folderPath,
    Body: '',
    ContentType: 'application/x-directory',
  });

  await client.send(command);
  res.json({ success: true, key: folderPath });
});

// 5GB threshold for multipart copy
const MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024;
const PART_SIZE = 100 * 1024 * 1024; // 100MB parts

function validateKey(key: string): { valid: true } | { valid: false; error: string } {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Key must be a non-empty string' };
  }
  if (key.includes('../') || key.startsWith('/')) {
    return { valid: false, error: 'Invalid object key' };
  }
  if (Buffer.byteLength(key, 'utf8') > 1024) {
    return { valid: false, error: 'Key exceeds maximum length of 1024 bytes' };
  }
  return { valid: true };
}

async function copyObjectWithMultipart(
  client: NonNullable<AuthenticatedRequest['s3Client']>,
  bucket: string,
  sourceKey: string,
  destinationKey: string,
  objectSize: number
): Promise<void> {
  const uploadId = await (async () => {
    const createCommand = new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: destinationKey,
    });
    const createResponse = await client.send(createCommand);
    if (!createResponse.UploadId) {
      throw new Error('Failed to initiate multipart upload');
    }
    return createResponse.UploadId;
  })();

  try {
    const parts: { ETag: string; PartNumber: number }[] = [];
    const totalParts = Math.ceil(objectSize / PART_SIZE);

    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const start = (partNumber - 1) * PART_SIZE;
      const end = Math.min(partNumber * PART_SIZE - 1, objectSize - 1);

      const copyPartCommand = new UploadPartCopyCommand({
        Bucket: bucket,
        Key: destinationKey,
        CopySource: encodeURIComponent(`${bucket}/${sourceKey}`),
        UploadId: uploadId,
        PartNumber: partNumber,
        CopySourceRange: `bytes=${start}-${end}`,
      });

      const copyPartResponse = await client.send(copyPartCommand);
      if (!copyPartResponse.CopyPartResult?.ETag) {
        throw new Error(`Failed to copy part ${partNumber}`);
      }

      parts.push({
        ETag: copyPartResponse.CopyPartResult.ETag,
        PartNumber: partNumber,
      });
    }

    const completeCommand = new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: destinationKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    });
    await client.send(completeCommand);
  } catch (err) {
    // Abort the multipart upload on error
    const abortCommand = new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: destinationKey,
      UploadId: uploadId,
    });
    await client.send(abortCommand).catch(() => {
      // Ignore abort errors
    });
    throw err;
  }
}

async function copyObject(
  client: NonNullable<AuthenticatedRequest['s3Client']>,
  bucket: string,
  sourceKey: string,
  destinationKey: string
): Promise<void> {
  // Get object size to determine copy method
  const headCommand = new HeadObjectCommand({
    Bucket: bucket,
    Key: sourceKey,
  });
  const headResponse = await client.send(headCommand);
  const objectSize = headResponse.ContentLength ?? 0;

  if (objectSize > MULTIPART_THRESHOLD) {
    await copyObjectWithMultipart(client, bucket, sourceKey, destinationKey, objectSize);
  } else {
    const copyCommand = new CopyObjectCommand({
      Bucket: bucket,
      Key: destinationKey,
      CopySource: encodeURIComponent(`${bucket}/${sourceKey}`),
    });
    await client.send(copyCommand);
  }
}

// POST /api/objects/:connectionId/:bucket/copy
router.post('/:connectionId/:bucket/copy', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as CopyRequestBody;
  const { sourceKey, destinationKey } = body;

  if (!sourceKey || !destinationKey) {
    res.status(400).json({ error: 'sourceKey and destinationKey are required' });
    return;
  }

  const sourceValidation = validateKey(sourceKey);
  if (!sourceValidation.valid) {
    res.status(400).json({ error: `Invalid sourceKey: ${sourceValidation.error}` });
    return;
  }

  const destValidation = validateKey(destinationKey);
  if (!destValidation.valid) {
    res.status(400).json({ error: `Invalid destinationKey: ${destValidation.error}` });
    return;
  }

  if (sourceKey === destinationKey) {
    res.status(400).json({ error: 'Source and destination keys cannot be the same' });
    return;
  }

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  await copyObject(client, bucket, sourceKey, destinationKey);
  res.json({ success: true });
});

// POST /api/objects/:connectionId/:bucket/batch-copy
router.post('/:connectionId/:bucket/batch-copy', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as BatchCopyRequestBody;
  const { operations } = body;

  if (!Array.isArray(operations) || operations.length === 0) {
    res.status(400).json({ error: 'Operations must be a non-empty array' });
    return;
  }

  if (operations.length > MAX_BATCH_OPERATIONS) {
    res.status(400).json({ error: `Cannot copy more than ${MAX_BATCH_OPERATIONS} objects at once` });
    return;
  }

  // Validate all operations
  for (const op of operations) {
    if (!op.sourceKey || !op.destinationKey) {
      res.status(400).json({ error: 'Each operation must have sourceKey and destinationKey' });
      return;
    }
    if (op.sourceKey === op.destinationKey) {
      res.status(400).json({ error: `sourceKey and destinationKey must differ for operation with key "${op.sourceKey}"` });
      return;
    }
    const sourceValidation = validateKey(op.sourceKey);
    if (!sourceValidation.valid) {
      res.status(400).json({ error: `Invalid sourceKey "${op.sourceKey}": ${sourceValidation.error}` });
      return;
    }
    const destValidation = validateKey(op.destinationKey);
    if (!destValidation.valid) {
      res.status(400).json({ error: `Invalid destinationKey "${op.destinationKey}": ${destValidation.error}` });
      return;
    }
  }

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const result: BatchCopyMoveResponse = { successful: [], errors: [] };

  for (const op of operations) {
    try {
      await copyObject(client, bucket, op.sourceKey, op.destinationKey);
      result.successful.push(op.sourceKey);
    } catch (err) {
      result.errors.push({
        sourceKey: op.sourceKey,
        message: err instanceof Error ? err.message : 'Copy failed',
      });
    }
  }

  res.json(result);
});

// POST /api/objects/:connectionId/:bucket/move
router.post('/:connectionId/:bucket/move', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as CopyRequestBody;
  const { sourceKey, destinationKey } = body;

  if (!sourceKey || !destinationKey) {
    res.status(400).json({ error: 'sourceKey and destinationKey are required' });
    return;
  }

  const sourceValidation = validateKey(sourceKey);
  if (!sourceValidation.valid) {
    res.status(400).json({ error: `Invalid sourceKey: ${sourceValidation.error}` });
    return;
  }

  const destValidation = validateKey(destinationKey);
  if (!destValidation.valid) {
    res.status(400).json({ error: `Invalid destinationKey: ${destValidation.error}` });
    return;
  }

  if (sourceKey === destinationKey) {
    res.status(400).json({ error: 'Source and destination keys cannot be the same' });
    return;
  }

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  // Copy first, then delete
  await copyObject(client, bucket, sourceKey, destinationKey);

  // Attempt to delete the source
  try {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucket,
      Key: sourceKey,
    });
    await client.send(deleteCommand);
  } catch (deleteErr) {
    // Copy succeeded but delete failed - attempt rollback
    try {
      const rollbackCommand = new DeleteObjectCommand({
        Bucket: bucket,
        Key: destinationKey,
      });
      await client.send(rollbackCommand);
    } catch (rollbackErr) {
      // Rollback also failed - log for observability and return partial success
      console.error('Move rollback failed', {
        destinationKey,
        sourceKey,
        bucket,
        deleteError: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        rollbackError: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
      res.status(500).json({
        success: false,
        partial: true,
        message: 'Move failed: copy succeeded but source delete failed, and rollback failed',
        destinationKey,
        error: deleteErr instanceof Error ? deleteErr.message : 'Delete failed',
      });
      return;
    }
    // Rollback succeeded - return error indicating the move was aborted
    res.status(500).json({
      success: false,
      message: 'Move failed: copy succeeded but source delete failed (copy was rolled back)',
      error: deleteErr instanceof Error ? deleteErr.message : 'Delete failed',
    });
    return;
  }

  res.json({ success: true });
});

// POST /api/objects/:connectionId/:bucket/batch-move
router.post('/:connectionId/:bucket/batch-move', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as BatchCopyRequestBody;
  const { operations } = body;

  if (!Array.isArray(operations) || operations.length === 0) {
    res.status(400).json({ error: 'Operations must be a non-empty array' });
    return;
  }

  if (operations.length > MAX_BATCH_OPERATIONS) {
    res.status(400).json({ error: `Cannot move more than ${MAX_BATCH_OPERATIONS} objects at once` });
    return;
  }

  // Validate all operations
  for (const op of operations) {
    if (!op.sourceKey || !op.destinationKey) {
      res.status(400).json({ error: 'Each operation must have sourceKey and destinationKey' });
      return;
    }
    if (op.sourceKey === op.destinationKey) {
      res.status(400).json({ error: `sourceKey and destinationKey must differ for operation with key "${op.sourceKey}"` });
      return;
    }
    const sourceValidation = validateKey(op.sourceKey);
    if (!sourceValidation.valid) {
      res.status(400).json({ error: `Invalid sourceKey "${op.sourceKey}": ${sourceValidation.error}` });
      return;
    }
    const destValidation = validateKey(op.destinationKey);
    if (!destValidation.valid) {
      res.status(400).json({ error: `Invalid destinationKey "${op.destinationKey}": ${destValidation.error}` });
      return;
    }
  }

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const result: BatchCopyMoveResponse = { successful: [], errors: [] };

  for (const op of operations) {
    try {
      // Copy first
      await copyObject(client, bucket, op.sourceKey, op.destinationKey);

      // Attempt to delete source - separate try/catch for better error reporting
      try {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: bucket,
          Key: op.sourceKey,
        });
        await client.send(deleteCommand);
        // Only mark as successful when both copy and delete succeed
        result.successful.push(op.sourceKey);
      } catch (deleteErr) {
        // Copy succeeded but delete failed - include destinationKey for remediation
        result.errors.push({
          sourceKey: op.sourceKey,
          destinationKey: op.destinationKey,
          message: `Delete failed after successful copy; destination created: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`,
        });
      }
    } catch (err) {
      // Copy failed
      result.errors.push({
        sourceKey: op.sourceKey,
        message: err instanceof Error ? err.message : 'Copy failed',
      });
    }
  }

  res.json(result);
});

// GET /api/objects/:connectionId/:bucket/metadata?key=...
router.get('/:connectionId/:bucket/metadata', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const key = req.query.key as string | undefined;

  if (!key) {
    res.status(400).json({ error: 'Object key is required' });
    return;
  }

  const keyValidation = validateKey(key);
  if (!keyValidation.valid) {
    res.status(400).json({ error: keyValidation.error });
    return;
  }

  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const command = new HeadObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  let response;
  try {
    response = await client.send(command);
  } catch (err: unknown) {
    const errorName = (err as { name?: string })?.name;
    if (errorName === 'NotFound' || errorName === 'NoSuchKey') {
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    throw err;
  }

  // Build encryption info
  let encryption: string | null = null;
  if (response.ServerSideEncryption) {
    if (response.ServerSideEncryption === 'AES256') {
      encryption = 'SSE-S3 (AES-256)';
    } else if (response.ServerSideEncryption === 'aws:kms') {
      encryption = response.SSEKMSKeyId
        ? `SSE-KMS (${response.SSEKMSKeyId})`
        : 'SSE-KMS';
    } else {
      encryption = response.ServerSideEncryption;
    }
  } else if (response.SSECustomerAlgorithm) {
    encryption = `SSE-C (${response.SSECustomerAlgorithm})`;
  }

  res.json({
    key,
    size: response.ContentLength,
    lastModified: response.LastModified?.toISOString(),
    contentType: response.ContentType,
    etag: response.ETag,
    encryption,
    storageClass: response.StorageClass ?? 'STANDARD',
  });
});

export default router;
