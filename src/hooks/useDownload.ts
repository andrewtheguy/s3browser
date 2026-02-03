import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { downloadFile, getDownloadUrl } from '../services/api';

export function useDownload() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;

  const getProxyDownloadUrl = useCallback(
    (key: string, versionId?: string): string => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error(
          `Missing S3 connection details: isConnected=${isConnected} | activeConnectionId=${activeConnectionId} | bucket=${bucket}`
        );
      }

      const params = new URLSearchParams();
      params.append('key', key);
      if (versionId) {
        params.append('versionId', versionId);
      }

      return `/api/download/${activeConnectionId}/${encodeURIComponent(bucket)}/object?${params.toString()}`;
    },
    [isConnected, activeConnectionId, bucket]
  );

  const getUrl = useCallback(
    async (key: string, versionId?: string): Promise<string> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error(
          `Missing S3 connection details: isConnected=${isConnected} | activeConnectionId=${activeConnectionId} | bucket=${bucket}`
        );
      }

      return getDownloadUrl(activeConnectionId, bucket, key, versionId);
    },
    [isConnected, activeConnectionId, bucket]
  );

  const download = useCallback(
    async (key: string, versionId?: string): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error(
          `Missing S3 connection details: isConnected=${isConnected} | activeConnectionId=${activeConnectionId} | bucket=${bucket}`
        );
      }

      await downloadFile(activeConnectionId, bucket, key, versionId);
    },
    [isConnected, activeConnectionId, bucket]
  );

  return { download, getDownloadUrl: getUrl, getProxyDownloadUrl };
}
