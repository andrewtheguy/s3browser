import { useState, useCallback, useRef, useEffect } from 'react';
import { useS3ClientContext } from '../contexts';
import { createFolder } from '../services/api';
import {
  getPresignedSingleUrl,
  uploadSingleFile,
  uploadFileMultipart,
  abortUpload,
  type CompletedPart,
} from '../services/api/multipartUpload';
import {
  saveUploadState,
  getUploadByFile,
  deleteUploadState,
  listPendingUploads,
  type PersistedUpload,
} from '../services/uploadPersistence';
import { UPLOAD_CONFIG } from '../config/upload';
import type { UploadProgress } from '../types';

export function useUpload() {
  const { isConnected } = useS3ClientContext();
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [pendingResumable, setPendingResumable] = useState<PersistedUpload[]>([]);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const mountGenerationRef = useRef(0);

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

    (async () => {
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

  const uploadSingleFileWithPresign = useCallback(
    async (uploadItem: UploadProgress, abortController: AbortController) => {
      const { file, key } = uploadItem;

      // Get presigned URL
      const { url } = await getPresignedSingleUrl(
        key,
        file.type || 'application/octet-stream',
        file.size
      );

      // Upload directly to S3
      await uploadSingleFile(
        url,
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
    [updateUpload]
  );

  const uploadMultipartFile = useCallback(
    async (
      uploadItem: UploadProgress,
      abortController: AbortController,
      existingUploadId?: string,
      existingParts?: CompletedPart[],
      persistenceId?: string
    ) => {
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

      const result = await uploadFileMultipart({
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
        onPartComplete: async (partNumber, etag, completed, total) => {
          // Update uploadId if not set yet (from initiate response)
          if (!uploadId && result) {
            uploadId = result.uploadId;
            sanitizedKey = result.key;
          }

          updateUpload(uploadItem.id, {
            completedParts: completed,
            totalParts: total,
            uploadId,
          });

          // Persist progress
          if (currentPersistenceId) {
            const allParts = existingParts ? [...existingParts] : [];
            if (!allParts.find((p) => p.partNumber === partNumber)) {
              allParts.push({ partNumber, etag });
            }
            try {
              // Update the persistence record with the new uploadId if needed
              await saveUploadState({
                id: currentPersistenceId,
                uploadId: uploadId || '',
                fileName: file.name,
                fileSize: file.size,
                fileLastModified: file.lastModified,
                key,
                sanitizedKey: sanitizedKey || key,
                contentType: file.type || 'application/octet-stream',
                completedParts: allParts,
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
    [updateUpload]
  );

  const upload = useCallback(
    async (files: File[], prefix: string = ''): Promise<void> => {
      if (!isConnected) {
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
            // Check for existing upload to resume
            const existingUpload = uploadItem.persistenceId
              ? await getUploadByFile(
                  uploadItem.file.name,
                  uploadItem.file.size,
                  uploadItem.file.lastModified
                ).catch(() => null)
              : null;

            await uploadMultipartFile(
              uploadItem,
              abortController,
              existingUpload?.uploadId,
              existingUpload?.completedParts,
              existingUpload?.id
            );
          } else {
            await uploadSingleFileWithPresign(uploadItem, abortController);
          }

          updateUpload(uploadItem.id, {
            status: 'completed',
            percentage: 100,
            canResume: false,
          });
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
    [isConnected, updateUpload, uploadSingleFileWithPresign, uploadMultipartFile, refreshPendingUploads]
  );

  const cancelUpload = useCallback(async (id: string) => {
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(id);
    }

    // Find the upload to get details for cleanup
    const uploadItem = uploads.find((u) => u.id === id);
    if (uploadItem?.uploadId && uploadItem.isMultipart) {
      // Abort the S3 multipart upload
      try {
        await abortUpload(uploadItem.uploadId, uploadItem.key);
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
  }, [uploads, refreshPendingUploads]);

  const pauseUpload = useCallback((id: string) => {
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(id);
    }

    updateUpload(id, {
      status: 'paused',
      isPaused: true,
    });
  }, [updateUpload]);

  const resumeUpload = useCallback(
    async (id: string) => {
      const uploadItem = uploads.find((u) => u.id === id);
      if (!uploadItem || !uploadItem.persistenceId) {
        throw new Error('Cannot resume upload - no persistence data');
      }

      // Get persisted state
      const persisted = await getUploadByFile(
        uploadItem.file.name,
        uploadItem.file.size,
        uploadItem.file.lastModified
      );

      if (!persisted) {
        throw new Error('Cannot resume upload - persistence data not found');
      }

      const abortController = new AbortController();
      abortControllersRef.current.set(id, abortController);

      updateUpload(id, {
        status: 'uploading',
        isPaused: false,
      });

      try {
        await uploadMultipartFile(
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
    [uploads, updateUpload, uploadMultipartFile, refreshPendingUploads]
  );

  const retryUpload = useCallback(
    async (id: string) => {
      const uploadItem = uploads.find((u) => u.id === id);
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
          await uploadMultipartFile(uploadItem, abortController);
        } else {
          await uploadSingleFileWithPresign(uploadItem, abortController);
        }

        updateUpload(id, {
          status: 'completed',
          percentage: 100,
          canResume: false,
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
    },
    [uploads, updateUpload, uploadSingleFileWithPresign, uploadMultipartFile]
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
    // Get the persisted upload to abort S3 if needed
    const pending = pendingResumable.find((p) => p.id === persistenceId);
    if (pending?.uploadId) {
      try {
        await abortUpload(pending.uploadId, pending.key);
      } catch (err) {
        console.error('Failed to abort S3 upload:', err);
      }
    }

    await deleteUploadState(persistenceId);
    setPendingResumable((prev) => prev.filter((p) => p.id !== persistenceId));
  }, [pendingResumable]);

  const createNewFolder = useCallback(
    async (folderName: string, prefix: string = ''): Promise<void> => {
      if (!isConnected) {
        throw new Error('Not connected to S3');
      }

      const folderPath = prefix + folderName;
      await createFolder(folderPath);
    },
    [isConnected]
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
