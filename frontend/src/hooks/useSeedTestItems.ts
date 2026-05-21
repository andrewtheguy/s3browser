import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { seedTestItems } from '../services/api';

export function useSeedTestItems() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;

  const seed = useCallback(
    async (prefix: string) => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error(
          `Missing S3 connection details: isConnected=${isConnected} | activeConnectionId=${activeConnectionId} | bucket=${bucket}`
        );
      }

      return seedTestItems(activeConnectionId, bucket, prefix);
    },
    [isConnected, activeConnectionId, bucket]
  );

  return { seedTestItems: seed };
}
