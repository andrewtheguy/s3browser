import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { downloadFile } from '../services/api';

export function useDownload() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;

  const download = useCallback(
    async (key: string): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error(
          `Missing S3 connection details: isConnected=${isConnected} | activeConnectionId=${activeConnectionId} | bucket=${bucket}`
        );
      }

      await downloadFile(activeConnectionId, bucket, key);
    },
    [isConnected, activeConnectionId, bucket]
  );

  return { download };
}
