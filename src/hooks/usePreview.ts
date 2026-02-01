import { useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { getFilePreview } from '../services/api';
import { isPreviewableFile } from '../utils/previewUtils';
import type { S3Object } from '../types';

interface PreviewState {
  isOpen: boolean;
  isLoading: boolean;
  error: string | null;
  content: string | null;
  item: S3Object | null;
  cannotPreviewReason: string | null;
}

export function usePreview() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;

  const [state, setState] = useState<PreviewState>({
    isOpen: false,
    isLoading: false,
    error: null,
    content: null,
    item: null,
    cannotPreviewReason: null,
  });

  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const openPreview = useCallback(
    async (item: S3Object) => {
      if (!isConnected || !activeConnectionId || !bucket) {
        return;
      }

      // Cancel any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Increment request ID to track this specific request
      const currentRequestId = ++requestIdRef.current;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const previewability = isPreviewableFile(item.name, item.size);

      if (!previewability.canPreview) {
        setState({
          isOpen: true,
          isLoading: false,
          error: null,
          content: null,
          item,
          cannotPreviewReason: previewability.reason || 'Cannot preview this file',
        });
        return;
      }

      setState({
        isOpen: true,
        isLoading: true,
        error: null,
        content: null,
        item,
        cannotPreviewReason: null,
      });

      try {
        const content = await getFilePreview(activeConnectionId, bucket, item.key);

        // Verify this request is still the active one before updating state
        if (currentRequestId !== requestIdRef.current) {
          return;
        }

        setState((prev) => ({
          ...prev,
          isLoading: false,
          content,
        }));
      } catch (err) {
        // Ignore aborted requests
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }

        // Verify this request is still the active one before updating state
        if (currentRequestId !== requestIdRef.current) {
          return;
        }

        const message = err instanceof Error ? err.message : 'Failed to load file content';
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: message,
        }));
      }
    },
    [isConnected, activeConnectionId, bucket]
  );

  const closePreview = useCallback(() => {
    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Invalidate any pending request
    requestIdRef.current++;

    setState({
      isOpen: false,
      isLoading: false,
      error: null,
      content: null,
      item: null,
      cannotPreviewReason: null,
    });
  }, []);

  return {
    ...state,
    openPreview,
    closePreview,
  };
}
