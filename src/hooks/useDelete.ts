import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { deleteObject, deleteObjects, listObjects } from '../services/api';
import type { S3Object } from '../types';

interface ResolveDeletePlanOptions {
  includeFolderContents?: boolean;
  signal?: AbortSignal;
}

interface DeletePlan {
  fileKeys: string[];
  folderKeys: string[];
}

const MAX_BATCH_DELETE = 1000;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

export function useDelete() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = useCallback(
    async (key: string): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      setIsDeleting(true);
      setError(null);

      try {
        await deleteObject(activeConnectionId, bucket, key);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delete failed';
        setError(message);
        throw err;
      } finally {
        setIsDeleting(false);
      }
    },
    [isConnected, activeConnectionId, bucket]
  );

  const removeMany = useCallback(
    async (keys: string[]): Promise<{ deleted: string[]; errors: Array<{ key: string; message: string }> }> => {
      if (keys.length === 0) {
        return { deleted: [], errors: [] };
      }

      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      setIsDeleting(true);
      setError(null);

      try {
        const deleted: string[] = [];
        const errors: Array<{ key: string; message: string }> = [];

        for (let i = 0; i < keys.length; i += MAX_BATCH_DELETE) {
          const batch = keys.slice(i, i + MAX_BATCH_DELETE);
          const result = await deleteObjects(activeConnectionId, bucket, batch);
          deleted.push(...result.deleted);
          errors.push(...result.errors);
        }

        return { deleted, errors };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Batch delete failed';
        setError(message);
        throw err;
      } finally {
        setIsDeleting(false);
      }
    },
    [isConnected, activeConnectionId, bucket]
  );

  const resolveDeletePlan = useCallback(
    async (items: S3Object[], options: ResolveDeletePlanOptions = {}): Promise<DeletePlan> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      const includeFolderContents = options.includeFolderContents ?? false;
      const fileKeys = new Set<string>();
      const folderKeys = new Set<string>();
      const queue: string[] = [];

      for (const item of items) {
        if (item.isFolder) {
          if (includeFolderContents) {
            if (!folderKeys.has(item.key)) {
              folderKeys.add(item.key);
              queue.push(item.key);
            }
          }
        } else {
          fileKeys.add(item.key);
        }
      }

      if (!includeFolderContents || queue.length === 0) {
        return { fileKeys: Array.from(fileKeys), folderKeys: [] };
      }

      while (queue.length > 0) {
        const prefix = queue.shift();
        if (!prefix) {
          continue;
        }

        let continuationToken: string | undefined = undefined;
        do {
          throwIfAborted(options.signal);
          const result = await listObjects(activeConnectionId, bucket, prefix, continuationToken, options.signal);
          for (const obj of result.objects) {
            if (obj.isFolder) {
              if (!folderKeys.has(obj.key)) {
                folderKeys.add(obj.key);
                queue.push(obj.key);
              }
            } else {
              fileKeys.add(obj.key);
            }
          }
          continuationToken = result.isTruncated ? result.continuationToken : undefined;
        } while (continuationToken);
      }

      return { fileKeys: Array.from(fileKeys), folderKeys: Array.from(folderKeys) };
    },
    [isConnected, activeConnectionId, bucket]
  );

  return {
    remove,
    removeMany,
    resolveDeletePlan,
    isDeleting,
    error,
  };
}
