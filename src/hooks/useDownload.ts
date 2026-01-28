import { useCallback, useState } from 'react';
import { useS3ClientContext } from '../contexts';
import { downloadFile } from '../services/api';

export function useDownload() {
  const { isConnected } = useS3ClientContext();
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(
    async (key: string): Promise<void> => {
      if (!isConnected) {
        throw new Error('Not connected to S3');
      }

      setIsDownloading(true);
      setError(null);

      try {
        await downloadFile(key);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Download failed';
        setError(message);
        throw err;
      } finally {
        setIsDownloading(false);
      }
    },
    [isConnected]
  );

  return {
    download,
    isDownloading,
    error,
  };
}
