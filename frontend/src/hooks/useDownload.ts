import { useCallback } from 'react';
import { useBucketRoute } from './useBucketRoute';
import { buildObjectUrl } from '../services/api';

export function useDownload() {
  const { connectionId: activeConnectionId, bucket } = useBucketRoute();

  const ensureS3Connection = useCallback((): { connectionId: number; bucket: string } => {
    if (!activeConnectionId || !bucket) {
      throw new Error(
        `Missing S3 connection details: activeConnectionId=${activeConnectionId} | bucket=${bucket}`
      );
    }
    return { connectionId: activeConnectionId, bucket };
  }, [activeConnectionId, bucket]);

  const getProxyDownloadUrl = useCallback(
    (key: string, versionId?: string): string => {
      const { connectionId, bucket: resolvedBucket } = ensureS3Connection();
      return buildObjectUrl(connectionId, resolvedBucket, key, { versionId, disposition: 'attachment' });
    },
    [ensureS3Connection]
  );

  const download = useCallback(
    (key: string, versionId?: string): void => {
      const url = getProxyDownloadUrl(key, versionId);
      const filename = key.split('/').pop() || 'download';

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },
    [getProxyDownloadUrl]
  );

  return { download, getProxyDownloadUrl };
}
