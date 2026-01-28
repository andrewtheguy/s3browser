import { useState, useCallback, useRef } from 'react';
import { useS3ClientContext } from '../contexts';
import { uploadFile, createFolder } from '../services/api';
import type { UploadProgress } from '../types';

export function useUpload() {
  const { isConnected } = useS3ClientContext();
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const upload = useCallback(
    async (files: File[], prefix: string = ''): Promise<void> => {
      if (!isConnected) {
        throw new Error('Not connected to S3');
      }

      const newUploads: UploadProgress[] = files.map((file) => ({
        file,
        key: prefix + file.name,
        loaded: 0,
        total: file.size,
        percentage: 0,
        status: 'pending' as const,
      }));

      setUploads((prev) => [...prev, ...newUploads]);

      for (const uploadItem of newUploads) {
        const abortController = new AbortController();
        abortControllersRef.current.set(uploadItem.key, abortController);

        setUploads((prev) =>
          prev.map((u) =>
            u.key === uploadItem.key ? { ...u, status: 'uploading' as const } : u
          )
        );

        try {
          await uploadFile({
            file: uploadItem.file,
            key: uploadItem.key,
            abortSignal: abortController.signal,
            onProgress: (loaded, total) => {
              setUploads((prev) =>
                prev.map((u) =>
                  u.key === uploadItem.key
                    ? {
                        ...u,
                        loaded,
                        total,
                        percentage: total > 0 ? Math.round((loaded / total) * 100) : 0,
                      }
                    : u
                )
              );
            },
          });

          setUploads((prev) =>
            prev.map((u) =>
              u.key === uploadItem.key
                ? { ...u, status: 'completed' as const, percentage: 100 }
                : u
            )
          );
        } catch (err) {
          // Ignore abort errors
          if (err instanceof DOMException && err.name === 'AbortError') {
            continue;
          }
          const message = err instanceof Error ? err.message : 'Upload failed';
          setUploads((prev) =>
            prev.map((u) =>
              u.key === uploadItem.key
                ? { ...u, status: 'error' as const, error: message }
                : u
            )
          );
        } finally {
          abortControllersRef.current.delete(uploadItem.key);
        }
      }
    },
    [isConnected]
  );

  const cancelUpload = useCallback((key: string) => {
    const controller = abortControllersRef.current.get(key);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(key);
    }
    setUploads((prev) => prev.filter((u) => u.key !== key));
  }, []);

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
    upload,
    cancelUpload,
    clearCompleted,
    clearAll,
    createNewFolder,
    isUploading: uploads.some((u) => u.status === 'uploading'),
  };
}
