import { useState, useCallback, useRef, useEffect } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { createFolder } from '../services/api';
import {
  uploadSingleFile,
  uploadFileMultipart,
  abortUpload,
  type CompletedPart,
} from '../services/api/multipartUpload';
import {
  saveUploadState,
  getUploadByFile,
  getUploadById,
  deleteUploadState,
  listPendingUploads,
  type PersistedUpload,
} from '../services/uploadPersistence';
import { UPLOAD_CONFIG } from '../config/upload';
import type { UploadCandidate, UploadProgress } from '../types';

export function useUpload() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [pendingResumable, setPendingResumable] = useState<PersistedUpload[]>([]);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const pendingQueueRef = useRef<string[]>([]);
  const queuedIdsRef = useRef<Set<string>>(new Set());
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const cancelledIdsRef = useRef<Set<string>>(new Set());
  const mountGenerationRef = useRef(0);

  // Refs to avoid stale closures in callbacks
  const uploadsRef = useRef<UploadProgress[]>(uploads);
  const pendingResumableRef = useRef<PersistedUpload[]>(pendingResumable);

  // Keep refs in sync with state
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  useEffect(() => {
    pendingResumableRef.current = pendingResumable;
  }, [pendingResumable]);

  const setUploadsAndSync = useCallback(
    (updater: (prev: UploadProgress[]) => UploadProgress[]) => {
      setUploads((prev) => {
        const next = updater(prev);
        uploadsRef.current = next;
        return next;
      });
    },
    []
  );

  const refreshPendingUploads = useCallback(async () => {
    const currentGeneration = mountGenerationRef.current;
    try {
      const pending = await listPendingUploads();
      if (currentGeneration === mountGenerationRef.current) {
        setPendingResumable(pending);
      }
    } catch (error) {
      console.error('Failed to refresh pending uploads:', error);
    }
  }, []);

  // Load pending resumable uploads on mount
  useEffect(() => {
    const generationRef = mountGenerationRef;
    const currentGeneration = ++generationRef.current;

    void (async () => {
      try {
        const pending = await listPendingUploads();
        if (currentGeneration === generationRef.current) {
          setPendingResumable(pending);
        }
      } catch (error) {
        console.error('Failed to load pending uploads:', error);
      }
    })();

    return () => {
      generationRef.current++;
    };
  }, []);

  // Cleanup on unmount: abort all in-progress uploads
  useEffect(() => {
    const controllers = abortControllersRef.current;
    return () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  const updateUpload = useCallback(
    (id: string, updates: Partial<UploadProgress>) => {
      setUploadsAndSync((prev) =>
        prev.map((u) => (u.id === id ? { ...u, ...updates } : u))
      );
    },
    [setUploadsAndSync]
  );

  const uploadSingleFileWithProxy = useCallback(
    async (uploadItem: UploadProgress, abortController: AbortController) => {
      if (!activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }
      const { file, key } = uploadItem;

      // Upload through server proxy
      await uploadSingleFile(
        activeConnectionId,
        bucket,
        key,
        file,
        (loaded, total) => {
          updateUpload(uploadItem.id, {
            loaded,
            total,
            percentage: total > 0 ? Math.round((loaded / total) * 100) : 0,
          });
        },
        abortController.signal
      );
    },
    [updateUpload, activeConnectionId, bucket]
  );

  const uploadMultipartFile = useCallback(
    async (
      uploadItem: UploadProgress,
      abortController: AbortController,
      existingUploadId?: string,
      existingParts?: CompletedPart[],
      persistenceId?: string
    ) => {
      if (!activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }
      const { file, key } = uploadItem;
      const totalParts = Math.ceil(file.size / UPLOAD_CONFIG.PART_SIZE);

      // Save to persistence if this is a new upload
      let currentPersistenceId = persistenceId;
      if (!currentPersistenceId) {
        const persisted = await saveUploadState({
          uploadId: existingUploadId || '',
          fileName: file.name,
          fileSize: file.size,
          fileLastModified: file.lastModified,
          key,
          sanitizedKey: key,
          contentType: file.type || 'application/octet-stream',
          completedParts: existingParts || [],
          totalParts,
        });
        currentPersistenceId = persisted.id;
      }

      updateUpload(uploadItem.id, {
        isMultipart: true,
        totalParts,
        completedParts: existingParts?.length || 0,
        canResume: true,
        persistenceId: currentPersistenceId,
      });

      let uploadId = existingUploadId;
      let sanitizedKey = key;

      // Mutable accumulator for completed parts - initialized from existingParts
      // and updated in onPartComplete to persist progress correctly
      const completedPartsAccumulator: CompletedPart[] = existingParts ? [...existingParts] : [];

      const result = await uploadFileMultipart({
        connectionId: activeConnectionId,
        bucket,
        file,
        key,
        existingUploadId,
        existingParts,
        abortSignal: abortController.signal,
        onProgress: (loaded, total) => {
          updateUpload(uploadItem.id, {
            loaded,
            total,
            percentage: total > 0 ? Math.round((loaded / total) * 100) : 0,
          });
        },
        onInitiated: (initiatedUploadId, initiatedSanitizedKey) => {
          uploadId = initiatedUploadId;
          sanitizedKey = initiatedSanitizedKey;
          updateUpload(uploadItem.id, { uploadId: initiatedUploadId });
        },
        onPartComplete: async (partNumber, etag, completed, total) => {
          updateUpload(uploadItem.id, {
            completedParts: completed,
            totalParts: total,
          });

          // Update the mutable accumulator (dedupe by partNumber)
          const existingIndex = completedPartsAccumulator.findIndex(
            (p) => p.partNumber === partNumber
          );
          if (existingIndex >= 0) {
            completedPartsAccumulator[existingIndex] = { partNumber, etag };
          } else {
            completedPartsAccumulator.push({ partNumber, etag });
          }

          // Persist progress
          if (currentPersistenceId) {
            try {
              await saveUploadState({
                id: currentPersistenceId,
                uploadId: uploadId || '',
                fileName: file.name,
                fileSize: file.size,
                fileLastModified: file.lastModified,
                key,
                sanitizedKey: sanitizedKey || key,
                contentType: file.type || 'application/octet-stream',
                completedParts: completedPartsAccumulator,
                totalParts: total,
              });
            } catch (err) {
              console.error('Failed to persist upload progress:', err);
            }
          }
        },
      });

      // Upload completed - clean up persistence
      if (currentPersistenceId) {
        void deleteUploadState(currentPersistenceId).catch(console.error);
      }

      return result;
    },
    [updateUpload, activeConnectionId, bucket]
  );

  const normalizePrefix = useCallback((prefix: string) => {
    if (!prefix) return '';
    const normalized = prefix.replace(/^\/+/, '');
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  }, []);

  const normalizeRelativePath = useCallback((path: string) => {
    return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  }, []);

  const stripPrefix = useCallback((key: string, prefix: string) => {
    if (prefix && key.startsWith(prefix)) {
      return key.slice(prefix.length);
    }
    return key;
  }, []);

  const runUpload = useCallback(
    async (id: string) => {
      if (cancelledIdsRef.current.has(id)) {
        return;
      }

      const uploadItem = uploadsRef.current.find((u) => u.id === id);
      if (!uploadItem || uploadItem.status === 'completed') {
        return;
      }

      const abortController = new AbortController();
      abortControllersRef.current.set(id, abortController);
      updateUpload(id, { status: 'uploading', error: undefined });

      let aborted = false;

      try {
        const useMultipart = uploadItem.file.size >= UPLOAD_CONFIG.MULTIPART_THRESHOLD;

        if (useMultipart) {
          const persistedData = uploadItem.persistenceId
            ? await getUploadById(uploadItem.persistenceId).catch(() => null)
            : null;

          const result = await uploadMultipartFile(
            uploadItem,
            abortController,
            persistedData?.uploadId ?? uploadItem.uploadId,
            persistedData?.completedParts,
            persistedData?.id ?? uploadItem.persistenceId
          );

          updateUpload(id, {
            status: 'completed',
            percentage: 100,
            canResume: false,
            completedParts: result.completedParts.length,
          });
        } else {
          await uploadSingleFileWithProxy(uploadItem, abortController);

          updateUpload(id, {
            status: 'completed',
            percentage: 100,
            canResume: false,
          });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          aborted = true;
          return;
        }
        const message = err instanceof Error ? err.message : 'Upload failed';
        updateUpload(id, {
          status: 'error',
          error: message,
        });
      } finally {
        abortControllersRef.current.delete(id);
        if (!aborted) {
          void refreshPendingUploads();
        }
      }
    },
    [updateUpload, uploadMultipartFile, uploadSingleFileWithProxy, refreshPendingUploads]
  );

  const processQueue = useCallback(() => {
    while (
      inFlightIdsRef.current.size < UPLOAD_CONFIG.FILE_CONCURRENCY &&
      pendingQueueRef.current.length > 0
    ) {
      const nextId = pendingQueueRef.current.shift();
      if (!nextId) return;

      queuedIdsRef.current.delete(nextId);

      if (cancelledIdsRef.current.has(nextId)) {
        continue;
      }

      const uploadItem = uploadsRef.current.find((u) => u.id === nextId);
      if (!uploadItem || uploadItem.status === 'completed') {
        continue;
      }

      inFlightIdsRef.current.add(nextId);

      void runUpload(nextId).finally(() => {
        inFlightIdsRef.current.delete(nextId);
        processQueue();
      });
    }
  }, [runUpload]);

  const enqueueUploadIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;

      for (const id of ids) {
        cancelledIdsRef.current.delete(id);
        if (queuedIdsRef.current.has(id) || inFlightIdsRef.current.has(id)) {
          continue;
        }
        queuedIdsRef.current.add(id);
        pendingQueueRef.current.push(id);
      }

      processQueue();
    },
    [processQueue]
  );

  const upload = useCallback(
    async (files: UploadCandidate[], prefix: string = ''): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      const normalizedPrefix = normalizePrefix(prefix);
      const newUploads: UploadProgress[] = [];

      for (const candidate of files) {
        const file = candidate.file;
        const webkitRelativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        const resolvedRelativePath = normalizeRelativePath(
          candidate.relativePath || webkitRelativePath || file.name
        );
        const explicitKey = candidate.key ? normalizeRelativePath(candidate.key) : '';
        const computedKey = explicitKey || `${normalizedPrefix}${resolvedRelativePath}`;

        const existingUpload = await getUploadByFile(
          file.name,
          file.size,
          file.lastModified
        ).catch(() => null);

        const canReuseExisting = existingUpload ? existingUpload.key === computedKey : false;

        const resumableUpload = canReuseExisting ? existingUpload : null;
        const key = resumableUpload?.key || computedKey;
        const displayPath = stripPrefix(key, normalizedPrefix);

        const uploadProgress: UploadProgress = {
          id: crypto.randomUUID(),
          file,
          key,
          relativePath: displayPath,
          loaded: 0,
          total: file.size,
          percentage: 0,
          status: file.size > UPLOAD_CONFIG.MAX_FILE_SIZE ? 'error' : 'pending',
          error: file.size > UPLOAD_CONFIG.MAX_FILE_SIZE ? 'File exceeds 5GB limit' : undefined,
          isMultipart: file.size >= UPLOAD_CONFIG.MULTIPART_THRESHOLD,
          canResume: resumableUpload !== null,
          uploadId: resumableUpload?.uploadId,
          completedParts: resumableUpload?.completedParts.length,
          totalParts: resumableUpload?.totalParts,
          persistenceId: resumableUpload?.id,
        };

        newUploads.push(uploadProgress);
      }

      setUploadsAndSync((prev) => [...prev, ...newUploads]);

      const queuedIds = newUploads
        .filter((uploadItem) => uploadItem.status !== 'error')
        .map((uploadItem) => uploadItem.id);

      enqueueUploadIds(queuedIds);

      void refreshPendingUploads();
    },
    [
      activeConnectionId,
      bucket,
      enqueueUploadIds,
      isConnected,
      normalizePrefix,
      normalizeRelativePath,
      refreshPendingUploads,
      setUploadsAndSync,
      stripPrefix,
    ]
  );

  const removeFromQueue = useCallback((id: string) => {
    pendingQueueRef.current = pendingQueueRef.current.filter((queuedId) => queuedId !== id);
    queuedIdsRef.current.delete(id);
  }, []);

  const cancelUploadInternal = useCallback(
    async (id: string, refresh: boolean) => {
      cancelledIdsRef.current.add(id);
      removeFromQueue(id);

      const controller = abortControllersRef.current.get(id);
      if (controller) {
        controller.abort();
        abortControllersRef.current.delete(id);
      }

      // Find the upload to get details for cleanup (read from ref to avoid stale closure)
      const uploadItem = uploadsRef.current.find((u) => u.id === id);
      if (uploadItem?.uploadId && uploadItem.isMultipart && activeConnectionId && bucket) {
        // Abort the S3 multipart upload
        try {
          await abortUpload(activeConnectionId, bucket, uploadItem.uploadId, uploadItem.key);
        } catch (err) {
          console.error('Failed to abort S3 upload:', err);
        }

        // Clean up persistence
        if (uploadItem.persistenceId) {
          void deleteUploadState(uploadItem.persistenceId).catch(console.error);
        }
      }

      setUploadsAndSync((prev) => prev.filter((u) => u.id !== id));

      if (refresh) {
        void refreshPendingUploads();
      }
    },
    [activeConnectionId, bucket, refreshPendingUploads, removeFromQueue, setUploadsAndSync]
  );

  const cancelUpload = useCallback(
    async (id: string) => {
      await cancelUploadInternal(id, true);
    },
    [cancelUploadInternal]
  );

  const pauseUpload = useCallback((id: string) => {
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(id);
    }

    // inFlight cleanup happens in runUpload/processQueue finally after AbortError.
    updateUpload(id, {
      status: 'paused',
    });
  }, [updateUpload]);

  const resumeUpload = useCallback(
    (id: string) => {
      const uploadItem = uploadsRef.current.find((u) => u.id === id);
      if (!uploadItem || !uploadItem.persistenceId) {
        throw new Error('Cannot resume upload - no persistence data');
      }

      updateUpload(id, {
        status: 'pending',
        error: undefined,
      });

      enqueueUploadIds([id]);
    },
    [enqueueUploadIds, updateUpload]
  );

  const retryUpload = useCallback(
    (id: string) => {
      const uploadItem = uploadsRef.current.find((u) => u.id === id);
      if (!uploadItem) return;

      updateUpload(id, {
        status: 'pending',
        error: undefined,
        loaded: 0,
        percentage: 0,
      });

      enqueueUploadIds([id]);
    },
    [enqueueUploadIds, updateUpload]
  );

  const clearCompleted = useCallback(() => {
    setUploadsAndSync((prev) => prev.filter((u) => u.status !== 'completed'));
  }, [setUploadsAndSync]);

  const cancelAll = useCallback(async () => {
    const idsToCancel = uploadsRef.current
      .filter((upload) => upload.status !== 'completed')
      .map((upload) => upload.id);

    if (idsToCancel.length === 0) return;

    pendingQueueRef.current = [];
    queuedIdsRef.current.clear();

    await Promise.all(idsToCancel.map((id) => cancelUploadInternal(id, false)));
    void refreshPendingUploads();
  }, [cancelUploadInternal, refreshPendingUploads]);

  const clearAll = useCallback(async () => {
    await cancelAll();
    setUploadsAndSync(() => []);
  }, [cancelAll, setUploadsAndSync]);

  const removePendingResumable = useCallback(async (persistenceId: string) => {
    // Get the persisted upload to abort S3 if needed (read from ref to avoid stale closure)
    const pending = pendingResumableRef.current.find((p) => p.id === persistenceId);
    if (pending?.uploadId && activeConnectionId && bucket) {
      try {
        await abortUpload(activeConnectionId, bucket, pending.uploadId, pending.key);
      } catch (err) {
        console.error('Failed to abort S3 upload:', err);
      }
    }

    await deleteUploadState(persistenceId);
    setPendingResumable((prev) => prev.filter((p) => p.id !== persistenceId));
  }, [activeConnectionId, bucket]);

  const createNewFolder = useCallback(
    async (folderName: string, prefix: string = ''): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      const folderPath = prefix + folderName;
      await createFolder(activeConnectionId, bucket, folderPath);
    },
    [isConnected, activeConnectionId, bucket]
  );

  return {
    uploads,
    pendingResumable,
    upload,
    cancelUpload,
    cancelAll,
    pauseUpload,
    resumeUpload,
    retryUpload,
    clearCompleted,
    clearAll,
    removePendingResumable,
    createNewFolder,
    isUploading: uploads.some((u) => u.status === 'uploading'),
  };
}
