import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { buildObjectUrl } from '../services/api';

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
      return buildObjectUrl(connectionId, resolvedBucket, key, { versionId });
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
