import { useState, useCallback, useRef, useEffect } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { getPresignedUrl } from '../services/api';
import { isPreviewableFile, getMimeType, type EmbedType } from '../utils/previewUtils';
import type { S3Object } from '../types';

// TTL for preview signed URLs (1 hour)
const PREVIEW_TTL_SECONDS = 3600;

interface PreviewState {
  isOpen: boolean;
  isLoading: boolean;
  error: string | null;
  signedUrl: string | null;
  embedType: EmbedType;
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
    signedUrl: null,
    embedType: 'unsupported',
    item: null,
    cannotPreviewReason: null,
  });

  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Cleanup on unmount: abort any in-flight request
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const openPreview = useCallback(
    async (item: S3Object) => {
      if (!isConnected || !activeConnectionId || !bucket) {
        return;
      }

      // Cancel any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Check previewability before allocating resources
      const previewability = isPreviewableFile(item.name);

      if (!previewability.canPreview) {
        setState({
          isOpen: true,
          isLoading: false,
          error: null,
          signedUrl: null,
          embedType: previewability.embedType,
          item,
          cannotPreviewReason: previewability.reason || 'Cannot preview this file',
        });
        return;
      }

      // Increment request ID to track this specific request
      const currentRequestId = ++requestIdRef.current;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      setState({
        isOpen: true,
        isLoading: true,
        error: null,
        signedUrl: null,
        embedType: previewability.embedType,
        item,
        cannotPreviewReason: null,
      });

      try {
        const mimeType = getMimeType(item.name);
        const signedUrl = await getPresignedUrl(
          activeConnectionId,
          bucket,
          item.key,
          PREVIEW_TTL_SECONDS,
          'inline',
          mimeType,
          abortController.signal,
          item.versionId
        );

        // Verify this request is still the active one before updating state
        if (currentRequestId !== requestIdRef.current) {
          return;
        }

        setState((prev) => ({
          ...prev,
          isLoading: false,
          signedUrl,
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

        const message = err instanceof Error ? err.message : 'Failed to load file preview';
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
      signedUrl: null,
      embedType: 'unsupported',
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
