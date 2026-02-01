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
import type { UploadProgress } from '../types';

export function useUpload() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [pendingResumable, setPendingResumable] = useState<PersistedUpload[]>([]);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
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

  const updateUpload = useCallback((id: string, updates: Partial<UploadProgress>) => {
    setUploads((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...updates } : u))
    );
  }, []);

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

  const upload = useCallback(
    async (files: File[], prefix: string = ''): Promise<void> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      const newUploads: UploadProgress[] = [];

      for (const file of files) {
        // Check if there's a resumable upload for this file
        const existingUpload = await getUploadByFile(
          file.name,
          file.size,
          file.lastModified
        ).catch(() => null);

        const uploadProgress: UploadProgress = {
          id: crypto.randomUUID(),
          file,
          key: prefix + file.name,
          loaded: 0,
          total: file.size,
          percentage: 0,
          status: file.size > UPLOAD_CONFIG.MAX_FILE_SIZE ? 'error' : 'pending',
          error: file.size > UPLOAD_CONFIG.MAX_FILE_SIZE ? 'File exceeds 5GB limit' : undefined,
          isMultipart: file.size >= UPLOAD_CONFIG.MULTIPART_THRESHOLD,
          canResume: existingUpload !== null,
          uploadId: existingUpload?.uploadId,
          completedParts: existingUpload?.completedParts.length,
          totalParts: existingUpload?.totalParts,
          persistenceId: existingUpload?.id,
        };

        newUploads.push(uploadProgress);
      }

      setUploads((prev) => [...prev, ...newUploads]);

      for (const uploadItem of newUploads) {

        // Skip files that exceed size limit
        if (uploadItem.status === 'error') {
          continue;
        }

        const abortController = new AbortController();
        abortControllersRef.current.set(uploadItem.id, abortController);

        updateUpload(uploadItem.id, { status: 'uploading' });

        try {
          const useMultipart = uploadItem.file.size >= UPLOAD_CONFIG.MULTIPART_THRESHOLD;

          if (useMultipart) {
            // Fetch full persistence data only if we have a persistenceId and need completedParts array
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

            updateUpload(uploadItem.id, {
              status: 'completed',
              percentage: 100,
              canResume: false,
              completedParts: result.completedParts.length,
            });
          } else {
            await uploadSingleFileWithProxy(uploadItem, abortController);

            updateUpload(uploadItem.id, {
              status: 'completed',
              percentage: 100,
              canResume: false,
            });
          }
        } catch (err) {
          // Ignore abort errors
          if (err instanceof DOMException && err.name === 'AbortError') {
            continue;
          }
          const message = err instanceof Error ? err.message : 'Upload failed';
          updateUpload(uploadItem.id, {
            status: 'error',
            error: message,
          });
        } finally {
          abortControllersRef.current.delete(uploadItem.id);
        }
      }

      // Refresh pending resumable list
      void refreshPendingUploads();
    },
    [isConnected, activeConnectionId, bucket, updateUpload, uploadSingleFileWithProxy, uploadMultipartFile, refreshPendingUploads]
  );

  const cancelUpload = useCallback(async (id: string) => {
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

    setUploads((prev) => prev.filter((u) => u.id !== id));

    // Refresh pending resumable list
    void refreshPendingUploads();
  }, [refreshPendingUploads, activeConnectionId, bucket]);

  const pauseUpload = useCallback((id: string) => {
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(id);
    }

    updateUpload(id, {
      status: 'paused',
    });
  }, [updateUpload]);

  const resumeUpload = useCallback(
    async (id: string) => {
      // Read from ref to avoid stale closure
      const uploadItem = uploadsRef.current.find((u) => u.id === id);
      if (!uploadItem || !uploadItem.persistenceId) {
        throw new Error('Cannot resume upload - no persistence data');
      }

      // Get persisted state using direct ID lookup
      const persisted = await getUploadById(uploadItem.persistenceId).catch(() => null);

      if (!persisted) {
        throw new Error('Cannot resume upload - persistence data not found');
      }

      const abortController = new AbortController();
      abortControllersRef.current.set(id, abortController);

      updateUpload(id, {
        status: 'uploading',
      });

      try {
        const result = await uploadMultipartFile(
          uploadItem,
          abortController,
          persisted.uploadId,
          persisted.completedParts,
          persisted.id
        );

        updateUpload(id, {
          status: 'completed',
          percentage: 100,
          canResume: false,
          completedParts: result.completedParts.length,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        const message = err instanceof Error ? err.message : 'Upload failed';
        updateUpload(id, {
          status: 'error',
          error: message,
        });
      } finally {
        abortControllersRef.current.delete(id);
      }

      // Refresh pending resumable list
      void refreshPendingUploads();
    },
    [updateUpload, uploadMultipartFile, refreshPendingUploads]
  );

  const retryUpload = useCallback(
    async (id: string) => {
      // Read from ref to avoid stale closure
      const uploadItem = uploadsRef.current.find((u) => u.id === id);
      if (!uploadItem) return;

      const abortController = new AbortController();
      abortControllersRef.current.set(id, abortController);

      updateUpload(id, {
        status: 'uploading',
        error: undefined,
        loaded: 0,
        percentage: 0,
      });

      try {
        const useMultipart = uploadItem.file.size >= UPLOAD_CONFIG.MULTIPART_THRESHOLD;

        if (useMultipart) {
          const result = await uploadMultipartFile(uploadItem, abortController);

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
          return;
        }
        const message = err instanceof Error ? err.message : 'Upload failed';
        updateUpload(id, {
          status: 'error',
          error: message,
        });
      } finally {
        abortControllersRef.current.delete(id);
      }
    },
    [updateUpload, uploadSingleFileWithProxy, uploadMultipartFile]
  );

  const clearCompleted = useCallback(() => {
    setUploads((prev) => prev.filter((u) => u.status !== 'completed'));
  }, []);

  const clearAll = useCallback(() => {
    // Abort any ongoing uploads
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    setUploads([]);
  }, []);

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
