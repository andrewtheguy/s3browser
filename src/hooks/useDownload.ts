import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { downloadFile } from '../services/api';

export function useDownload() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(
    async (key: string): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      setIsDownloading(true);
      setError(null);

      try {
        await downloadFile(activeConnectionId, bucket, key);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Download failed';
        setError(message);
        throw err;
      } finally {
        setIsDownloading(false);
      }
    },
    [isConnected, activeConnectionId, bucket]
  );

  return {
    download,
    isDownloading,
    error,
  };
}
