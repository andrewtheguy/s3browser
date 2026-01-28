import { useCallback, useState } from 'react';
import { useS3ClientContext } from '../contexts';
import { deleteObject } from '../services/api';

export function useDelete() {
  const { isConnected } = useS3ClientContext();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = useCallback(
    async (key: string): Promise<void> => {
      if (!isConnected) {
        throw new Error('Not connected to S3');
      }

      setIsDeleting(true);
      setError(null);

      try {
        await deleteObject(key);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delete failed';
        setError(message);
        throw err;
      } finally {
        setIsDeleting(false);
      }
    },
    [isConnected]
  );

  return {
    remove,
    isDeleting,
    error,
  };
}
