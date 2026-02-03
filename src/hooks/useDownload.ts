import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { downloadFile, getDownloadUrl } from '../services/api';

export function useDownload() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;

  const ensureS3Connection = useCallback((): { connectionId: number; bucket: string } => {
    if (!isConnected || !activeConnectionId || !bucket) {
      throw new Error(
        `Missing S3 connection details: isConnected=${isConnected} | activeConnectionId=${activeConnectionId} | bucket=${bucket}`
      );
    }
    return { connectionId: activeConnectionId, bucket };
  }, [isConnected, activeConnectionId, bucket]);

  const getProxyDownloadUrl = useCallback(
    (key: string, versionId?: string): string => {
      const { connectionId, bucket: resolvedBucket } = ensureS3Connection();

      const params = new URLSearchParams();
      params.append('key', key);
      if (versionId) {
        params.append('versionId', versionId);
      }

      return `/api/download/${connectionId}/${encodeURIComponent(resolvedBucket)}/object?${params.toString()}`;
    },
    [ensureS3Connection]
  );

  const getUrl = useCallback(
    async (key: string, versionId?: string): Promise<string> => {
      const { connectionId, bucket: resolvedBucket } = ensureS3Connection();

      return getDownloadUrl(connectionId, resolvedBucket, key, versionId);
    },
    [ensureS3Connection]
  );

  const download = useCallback(
    async (key: string, versionId?: string): Promise<void> => {
      const { connectionId, bucket: resolvedBucket } = ensureS3Connection();

      await downloadFile(connectionId, resolvedBucket, key, versionId);
    },
    [ensureS3Connection]
  );

  return { download, getDownloadUrl: getUrl, getProxyDownloadUrl };
}
