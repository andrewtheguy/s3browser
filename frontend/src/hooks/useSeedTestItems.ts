import { useCallback } from 'react';
import { useBucketRoute } from './useBucketRoute';
import { seedTestItems } from '../services/api';

export function useSeedTestItems() {
  const { connectionId: activeConnectionId, bucket } = useBucketRoute();

  const seed = useCallback(
    async (prefix: string) => {
      if (!activeConnectionId || !bucket) {
        throw new Error(
          `Missing S3 connection details: activeConnectionId=${activeConnectionId} | bucket=${bucket}`
        );
      }

      return seedTestItems(activeConnectionId, bucket, prefix);
    },
    [activeConnectionId, bucket]
  );

  return { seedTestItems: seed };
}
