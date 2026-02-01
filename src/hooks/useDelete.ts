import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { deleteObject, deleteObjects } from '../services/api';

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
        const result = await deleteObjects(activeConnectionId, bucket, keys);
        return result;
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

  return {
    remove,
    removeMany,
    isDeleting,
    error,
  };
}
