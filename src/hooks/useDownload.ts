import { useCallback, useState } from 'react';
import { useS3ClientContext } from '../contexts';
import { downloadObject } from '../services/s3';

export function useDownload() {
  const { client, credentials } = useS3ClientContext();
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(
    async (key: string): Promise<void> => {
      if (!client || !credentials) {
        throw new Error('Not connected to S3');
      }

      setIsDownloading(true);
      setError(null);

      try {
        await downloadObject({
          client,
          bucket: credentials.bucket,
          key,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Download failed';
        setError(message);
        throw err;
      } finally {
        setIsDownloading(false);
      }
    },
    [client, credentials]
  );

  return {
    download,
    isDownloading,
    error,
  };
}
