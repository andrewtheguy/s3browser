import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { deleteObject, deleteObjects } from '../services/api';
import { useResolveObjectPlan } from './useResolveObjectPlan';

const MAX_BATCH_DELETE = 1000;
const MAX_BATCH_DELETE_BYTES = 90_000;

function buildDeleteBatches(keys: Array<{ key: string; versionId?: string }>): Array<Array<{ key: string; versionId?: string }>> {
  const encoder = new TextEncoder();
  const baseBytes = encoder.encode('{"keys":[]}').length;
  const batches: Array<Array<{ key: string; versionId?: string }>> = [];
  let current: Array<{ key: string; versionId?: string }> = [];
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

export function useDelete() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { resolveObjectPlan } = useResolveObjectPlan();

  const remove = useCallback(
    async (key: string, versionId?: string): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      setIsDeleting(true);
      setError(null);

      try {
        await deleteObject(activeConnectionId, bucket, key, versionId);
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
    async (
      keys: Array<{ key: string; versionId?: string }>
    ): Promise<{
      deleted: Array<{ key: string; versionId?: string }>;
      errors: Array<{ key: string; message: string }>;
    }> => {
      if (keys.length === 0) {
        return { deleted: [], errors: [] };
      }

      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      setIsDeleting(true);
      setError(null);

      const deleted: Array<{ key: string; versionId?: string }> = [];
      const errors: Array<{ key: string; message: string }> = [];
      let currentBatch: Array<{ key: string; versionId?: string }> = [];

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
            ...currentBatch.map((entry) => ({
              key: entry.key,
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

  return {
    remove,
    removeMany,
    resolveObjectPlan,
    isDeleting,
    error,
  };
}
