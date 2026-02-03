import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { deleteObject, deleteObjects, listObjects } from '../services/api';
import type { S3Object } from '../types';

interface ResolveDeletePlanOptions {
  includeFolderContents?: boolean;
  signal?: AbortSignal;
  onContinuationPrompt?: (currentCount: number) => boolean | Promise<boolean>;
  continuationPromptEvery?: number;
  continuationPromptStartAt?: number;
}

interface DeletePlan {
  fileKeys: string[];
  folderKeys: string[];
}

const MAX_BATCH_DELETE = 1000;
const MAX_BATCH_DELETE_BYTES = 90_000;
const DELETE_CONTINUATION_PROMPT_EVERY = 10_000;

function buildDeleteBatches(keys: string[]): string[][] {
  const encoder = new TextEncoder();
  const baseBytes = encoder.encode('{"keys":[]}').length;
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = baseBytes;

  for (const key of keys) {
    const keyBytes = encoder.encode(JSON.stringify(key)).length;
    const separatorBytes = current.length > 0 ? 1 : 0;
    const nextBytes = currentBytes + keyBytes + separatorBytes;
    const willExceed =
      current.length + 1 > MAX_BATCH_DELETE || nextBytes > MAX_BATCH_DELETE_BYTES;

    if (willExceed) {
      if (current.length > 0) {
        batches.push(current);
        current = [key];
        currentBytes = baseBytes + keyBytes;
      } else {
        batches.push([key]);
        current = [];
        currentBytes = baseBytes;
      }
    } else {
      current.push(key);
      currentBytes = nextBytes;
    }
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

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

      const deleted: string[] = [];
      const errors: Array<{ key: string; message: string }> = [];
      let currentBatch: string[] = [];

      try {
        const batches = buildDeleteBatches(keys);
        for (const batch of batches) {
          currentBatch = batch;
          const result = await deleteObjects(activeConnectionId, bucket, batch);
          deleted.push(...result.deleted);
          errors.push(...result.errors);
          currentBatch = [];
        }

        return { deleted, errors };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Batch delete failed';
        setError(message);
        if (currentBatch.length > 0) {
          errors.push(
            ...currentBatch.map((key) => ({
              key,
              message,
            }))
          );
        }
        return { deleted, errors };
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
      const promptEvery = Math.max(
        options.continuationPromptEvery ?? DELETE_CONTINUATION_PROMPT_EVERY,
        1
      );
      const promptStartAt = Math.max(
        options.continuationPromptStartAt ?? promptEvery,
        1
      );
      let nextContinuationPromptAt = promptStartAt;

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
          const result = await listObjects(
            activeConnectionId,
            bucket,
            prefix,
            false,
            continuationToken,
            options.signal
          );
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

          if (
            fileKeys.size >= nextContinuationPromptAt &&
            (continuationToken || queue.length > 0)
          ) {
            const shouldContinue = await Promise.resolve(
              options.onContinuationPrompt?.(fileKeys.size) ?? true
            );
            if (!shouldContinue) {
              return { fileKeys: Array.from(fileKeys), folderKeys: Array.from(folderKeys) };
            }
            nextContinuationPromptAt += promptEvery;
          }
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
