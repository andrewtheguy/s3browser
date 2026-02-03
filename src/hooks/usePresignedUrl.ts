import { useState, useCallback } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { getPresignedUrl } from '../services/api/download';

export interface CopyPresignedUrlResult {
  success: boolean;
  /** The URL that was copied (or attempted to copy). Present on success and when clipboard is unavailable. */
  url?: string;
}

export function usePresignedUrl() {
  const { activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;
  const [isLoading, setIsLoading] = useState(false);

  const copyPresignedUrl = useCallback(
    async (key: string, ttl: number = 86400, versionId?: string): Promise<CopyPresignedUrlResult> => {
    if (!activeConnectionId || !bucket) {
      return { success: false };
    }

    setIsLoading(true);
    try {
      const url = await getPresignedUrl(
        activeConnectionId,
        bucket,
        key,
        ttl,
        undefined,
        undefined,
        undefined,
        versionId
      );

      // Check if clipboard API is available (not available in SSR or insecure contexts)
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        return { success: true, url };
      }

      // Clipboard unavailable - return URL for manual copy dialog
      return { success: false, url };
    } catch (err) {
      console.error('usePresignedUrl: failed to get presigned URL', err);
      return { success: false };
    } finally {
      setIsLoading(false);
    }
  }, [activeConnectionId, bucket]);

  const copyS3Uri = useCallback(async (key: string): Promise<CopyPresignedUrlResult> => {
    if (!bucket) {
      return { success: false };
    }

    const s3Uri = `s3://${bucket}/${key}`;

    // Check if clipboard API is available
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(s3Uri);
        return { success: true, url: s3Uri };
      } catch (err) {
        console.error('usePresignedUrl: failed to copy S3 URI', err);
        return { success: false, url: s3Uri };
      }
    }

    // Clipboard unavailable - return URL for manual copy dialog
    return { success: false, url: s3Uri };
  }, [bucket]);

  return { copyPresignedUrl, copyS3Uri, isLoading };
}
