import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import {
  copyObject,
  copyObjects,
  moveObject,
  moveObjects,
  listObjects,
  type CopyMoveOperation,
  type BatchCopyMoveResponse,
} from '../services/api';
import type { S3Object } from '../types';

interface ResolveCopyMovePlanOptions {
  signal?: AbortSignal;
}

export interface CopyMovePlan {
  operations: CopyMoveOperation[];
  folderKeys: string[];
}

const MAX_BATCH_SIZE = 1000;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function computeDestinationKey(sourceKey: string, sourcePrefix: string, destPrefix: string): string {
  // Extract the relative path from source
  const relativePath = sourceKey.startsWith(sourcePrefix)
    ? sourceKey.slice(sourcePrefix.length)
    : sourceKey;
  return destPrefix + relativePath;
}

export function useCopyMove() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;
  const [isCopying, setIsCopying] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = useCallback(
    async (sourceKey: string, destinationKey: string, signal?: AbortSignal): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      setIsCopying(true);
      setError(null);

      try {
        await copyObject(activeConnectionId, bucket, sourceKey, destinationKey, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Copy failed';
        setError(message);
        throw err;
      } finally {
        setIsCopying(false);
      }
    },
    [isConnected, activeConnectionId, bucket]
  );

  const move = useCallback(
    async (sourceKey: string, destinationKey: string, signal?: AbortSignal): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      setIsMoving(true);
      setError(null);

      try {
        await moveObject(activeConnectionId, bucket, sourceKey, destinationKey, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Move failed';
        setError(message);
        throw err;
      } finally {
        setIsMoving(false);
      }
    },
    [isConnected, activeConnectionId, bucket]
  );

  const copyMany = useCallback(
    async (
      operations: CopyMoveOperation[],
      signal?: AbortSignal
    ): Promise<BatchCopyMoveResponse> => {
      if (operations.length === 0) {
        return { copied: [], errors: [] };
      }

      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      setIsCopying(true);
      setError(null);

      const copied: string[] = [];
      const errors: Array<{ sourceKey: string; message: string }> = [];
      let currentBatch: CopyMoveOperation[] = [];

      try {
        for (let i = 0; i < operations.length; i += MAX_BATCH_SIZE) {
          throwIfAborted(signal);
          const batch = operations.slice(i, i + MAX_BATCH_SIZE);
          currentBatch = batch;
          const result = await copyObjects(activeConnectionId, bucket, batch, signal);
          copied.push(...result.copied);
          errors.push(...result.errors);
          currentBatch = [];
        }

        return { copied, errors };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Batch copy failed';
        setError(message);
        if (currentBatch.length > 0) {
          errors.push(
            ...currentBatch.map((op) => ({
              sourceKey: op.sourceKey,
              message,
            }))
          );
        }
        return { copied, errors };
      } finally {
        setIsCopying(false);
      }
    },
    [isConnected, activeConnectionId, bucket]
  );

  const moveMany = useCallback(
    async (
      operations: CopyMoveOperation[],
      signal?: AbortSignal
    ): Promise<BatchCopyMoveResponse> => {
      if (operations.length === 0) {
        return { copied: [], errors: [] };
      }

      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      setIsMoving(true);
      setError(null);

      const copied: string[] = [];
      const errors: Array<{ sourceKey: string; message: string }> = [];
      let currentBatch: CopyMoveOperation[] = [];

      try {
        for (let i = 0; i < operations.length; i += MAX_BATCH_SIZE) {
          throwIfAborted(signal);
          const batch = operations.slice(i, i + MAX_BATCH_SIZE);
          currentBatch = batch;
          const result = await moveObjects(activeConnectionId, bucket, batch, signal);
          copied.push(...result.copied);
          errors.push(...result.errors);
          currentBatch = [];
        }

        return { copied, errors };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Batch move failed';
        setError(message);
        if (currentBatch.length > 0) {
          errors.push(
            ...currentBatch.map((op) => ({
              sourceKey: op.sourceKey,
              message,
            }))
          );
        }
        return { copied, errors };
      } finally {
        setIsMoving(false);
      }
    },
    [isConnected, activeConnectionId, bucket]
  );

  const resolveCopyMovePlan = useCallback(
    async (
      items: S3Object[],
      destPrefix: string,
      options: ResolveCopyMovePlanOptions = {}
    ): Promise<CopyMovePlan> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      const operations: CopyMoveOperation[] = [];
      const folderKeys: string[] = [];
      const queue: Array<{ prefix: string; sourceBasePrefix: string }> = [];

      for (const item of items) {
        if (item.isFolder) {
          // For folders, we need to recursively list and copy all contents
          folderKeys.push(item.key);
          // The source base prefix is the folder key itself
          queue.push({ prefix: item.key, sourceBasePrefix: item.key });
        } else {
          // For files, compute destination based on file name only
          const fileName = item.key.split('/').pop() || item.key;
          operations.push({
            sourceKey: item.key,
            destinationKey: destPrefix + fileName,
          });
        }
      }

      // Process folders recursively
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;

        let continuationToken: string | undefined = undefined;
        do {
          throwIfAborted(options.signal);
          const result = await listObjects(
            activeConnectionId,
            bucket,
            current.prefix,
            continuationToken,
            options.signal
          );

          for (const obj of result.objects) {
            if (obj.isFolder) {
              folderKeys.push(obj.key);
              queue.push({ prefix: obj.key, sourceBasePrefix: current.sourceBasePrefix });
            } else {
              operations.push({
                sourceKey: obj.key,
                destinationKey: computeDestinationKey(
                  obj.key,
                  current.sourceBasePrefix,
                  destPrefix
                ),
              });
            }
          }

          continuationToken = result.isTruncated ? result.continuationToken : undefined;
        } while (continuationToken);
      }

      return { operations, folderKeys };
    },
    [isConnected, activeConnectionId, bucket]
  );

  return {
    copy,
    move,
    copyMany,
    moveMany,
    resolveCopyMovePlan,
    isCopying,
    isMoving,
    error,
  };
}
