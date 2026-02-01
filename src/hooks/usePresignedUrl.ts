import { useState, useCallback } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { getPresignedUrl } from '../services/api/download';

export interface CopyPresignedUrlResult {
  success: boolean;
  /** Present when clipboard is unavailable - show in dialog for manual copy */
  url?: string;
}

export function usePresignedUrl() {
  const { activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;
  const [isLoading, setIsLoading] = useState(false);

  const copyPresignedUrl = useCallback(async (key: string): Promise<CopyPresignedUrlResult> => {
    if (!activeConnectionId || !bucket) {
      return { success: false };
    }

    setIsLoading(true);
    try {
      const url = await getPresignedUrl(activeConnectionId, bucket, key);

      // Check if clipboard API is available (not available in SSR or insecure contexts)
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        return { success: true };
      }

      // Clipboard unavailable - return URL for manual copy dialog
      return { success: false, url };
    } catch {
      return { success: false };
    } finally {
      setIsLoading(false);
    }
  }, [activeConnectionId, bucket]);

  return { copyPresignedUrl, isLoading };
}
