import { useState, useCallback } from 'react';
import { getPresignedUrl } from '../services/api/download';

export function usePresignedUrl() {
  const [isLoading, setIsLoading] = useState(false);

  const copyPresignedUrl = useCallback(async (key: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      const url = await getPresignedUrl(key);
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { copyPresignedUrl, isLoading };
}
