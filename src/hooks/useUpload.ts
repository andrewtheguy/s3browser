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
  clearAllPendingUploads,
  type PersistedUpload,
} from '../services/uploadPersistence';
import { UPLOAD_CONFIG } from '../config/upload';
import type { UploadCandidate, UploadProgress } from '../types';

export interface CompletedStats {
  count: number;
  size: number;
}

interface UploadLockRecord {
  id: string;
  updatedAt: number;
  active: boolean;
}

const UPLOAD_LOCK_KEY = 's3browser-upload-lock';
const UPLOAD_LOCK_STALE_MS = 2 * 60 * 1000;
const UPLOAD_LOCK_HEARTBEAT_MS = 30 * 1000;

export function useUpload() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [pendingResumable, setPendingResumable] = useState<PersistedUpload[]>([]);
  const [completedStats, setCompletedStats] = useState<CompletedStats>({ count: 0, size: 0 });
  const [isUploadBlocked, setIsUploadBlocked] = useState(false);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const pendingQueueRef = useRef<string[]>([]);
  const queuedIdsRef = useRef<Set<string>>(new Set());
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const cancelledIdsRef = useRef<Set<string>>(new Set());
  const mountGenerationRef = useRef(0);
  const sessionIdRef = useRef(crypto.randomUUID());
  const pendingUpdatesRef = useRef<Map<string, Partial<UploadProgress>>>(new Map());
  const updateFlushScheduledRef = useRef(false);
  const progressTimersRef = useRef<Map<string, number>>(new Map());
  const progressPendingRef = useRef<Map<string, { loaded: number; total: number }>>(new Map());
  const progressLastRef = useRef<Map<string, number>>(new Map());

  const PROGRESS_UPDATE_INTERVAL_MS = 150;

  // Refs to avoid stale closures in callbacks
  const uploadsRef = useRef<UploadProgress[]>(uploads);
  const pendingResumableRef = useRef<PersistedUpload[]>(pendingResumable);

  const releaseUploadFileReferences = useCallback(() => {
    if (uploadsRef.current.length === 0) return;
    for (const upload of uploadsRef.current) {
      upload.file = null;
    }
  }, []);

  const resetQueueState = useCallback(() => {
    pendingQueueRef.current = [];
    queuedIdsRef.current.clear();
    inFlightIdsRef.current.clear();
    cancelledIdsRef.current.clear();
  }, []);

  const releaseUploadFileReference = useCallback((id: string) => {
    const uploadItem = uploadsRef.current.find((upload) => upload.id === id);
    if (uploadItem) {
      uploadItem.file = null;
    }
  }, []);

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

  const flushBatchedUpdates = useCallback(() => {
    updateFlushScheduledRef.current = false;
    const pendingUpdates = pendingUpdatesRef.current;
    if (pendingUpdates.size === 0) return;
    pendingUpdatesRef.current = new Map();

    setUploadsAndSync((prev) =>
      prev.map((upload) => {
        const updates = pendingUpdates.get(upload.id);
        if (!updates) return upload;
        return { ...upload, ...updates };
      })
    );
  }, [setUploadsAndSync]);

  const scheduleBatchedUpdatesFlush = useCallback(() => {
    if (updateFlushScheduledRef.current) return;
    updateFlushScheduledRef.current = true;
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(flushBatchedUpdates);
      return;
    }
    void Promise.resolve().then(flushBatchedUpdates);
  }, [flushBatchedUpdates]);

  const clearProgressState = useCallback((id: string) => {
    const timerId = progressTimersRef.current.get(id);
    if (timerId) {
      window.clearTimeout(timerId);
    }
    progressTimersRef.current.delete(id);
    progressPendingRef.current.delete(id);
    progressLastRef.current.delete(id);
  }, []);


  const readUploadLock = useCallback((): UploadLockRecord | null => {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(UPLOAD_LOCK_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as UploadLockRecord;
    } catch {
      return null;
    }
  }, []);

  const isLockStale = useCallback((lock: UploadLockRecord) => {
    return Date.now() - lock.updatedAt > UPLOAD_LOCK_STALE_MS;
  }, []);

  const syncUploadBlockState = useCallback(() => {
    if (typeof window === 'undefined') return;
    const lock = readUploadLock();
    if (!lock) {
      setIsUploadBlocked(false);
      return;
    }
    if (isLockStale(lock)) {
      setIsUploadBlocked(false);
      return;
    }
    setIsUploadBlocked(lock.active && lock.id !== sessionIdRef.current);
  }, [isLockStale, readUploadLock]);

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
        const existingLock = readUploadLock();
        const lockIsStale = !existingLock || isLockStale(existingLock);
        if (lockIsStale) {
          await clearAllPendingUploads();
          if (currentGeneration === generationRef.current) {
            setPendingResumable([]);
          }
          return;
        }
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
  }, [isLockStale, readUploadLock]);

  // Cleanup on unmount: abort all in-progress uploads
  useEffect(() => {
    const controllers = abortControllersRef.current;
    const progressTimers = progressTimersRef.current;
    const progressPending = progressPendingRef.current;
    const progressLast = progressLastRef.current;
    return () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
      for (const timerId of progressTimers.values()) {
        window.clearTimeout(timerId);
      }
      progressTimers.clear();
      progressPending.clear();
      progressLast.clear();
    };
  }, []);

  useEffect(() => {
    if (uploads.length === 0) {
      resetQueueState();
    }
  }, [uploads.length, resetQueueState]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    syncUploadBlockState();

    const handleStorage = (event: StorageEvent) => {
      if (event.key === UPLOAD_LOCK_KEY) {
        syncUploadBlockState();
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [syncUploadBlockState]);

  const updateUpload = useCallback(
    (id: string, updates: Partial<UploadProgress>) => {
      const existingUpdates = pendingUpdatesRef.current.get(id);
      pendingUpdatesRef.current.set(id, existingUpdates ? { ...existingUpdates, ...updates } : updates);
      scheduleBatchedUpdatesFlush();
    },
    [scheduleBatchedUpdatesFlush]
  );

  const scheduleProgressUpdate = useCallback(
    (id: string, loaded: number, total: number) => {
      const now = Date.now();
      const lastUpdate = progressLastRef.current.get(id) ?? 0;
      const elapsed = now - lastUpdate;
      const percentage = total > 0 ? Math.round((loaded / total) * 100) : 0;

      if (elapsed >= PROGRESS_UPDATE_INTERVAL_MS && !progressTimersRef.current.has(id)) {
        progressLastRef.current.set(id, now);
        updateUpload(id, { loaded, total, percentage });
        return;
      }

      progressPendingRef.current.set(id, { loaded, total });
      if (!progressTimersRef.current.has(id)) {
        const delay = Math.max(PROGRESS_UPDATE_INTERVAL_MS - elapsed, 0);
        const timerId = window.setTimeout(() => {
          progressTimersRef.current.delete(id);
          const pending = progressPendingRef.current.get(id);
          if (!pending) return;
          progressPendingRef.current.delete(id);
          progressLastRef.current.set(id, Date.now());
          const nextPercentage =
            pending.total > 0 ? Math.round((pending.loaded / pending.total) * 100) : 0;
          updateUpload(id, {
            loaded: pending.loaded,
            total: pending.total,
            percentage: nextPercentage,
          });
        }, delay);
        progressTimersRef.current.set(id, timerId);
      }
    },
    [updateUpload]
  );

  // Mark upload as completed: update stats and clear file reference
  const markCompleted = useCallback(
    (id: string, fileSize: number) => {
      clearProgressState(id);
      setCompletedStats((prev) => ({
        count: prev.count + 1,
        size: prev.size + fileSize,
      }));
      releaseUploadFileReference(id);
      setUploadsAndSync((prev) => {
        return prev.filter((u) => u.id !== id);
      });
    },
    [clearProgressState, releaseUploadFileReference, setUploadsAndSync]
  );

  const uploadSingleFileWithProxy = useCallback(
    async (uploadItem: UploadProgress, abortController: AbortController) => {
      if (!activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }
      const { file, key } = uploadItem;
      if (!file) {
        throw new Error('File reference is no longer available for upload');
      }

      // Upload through server proxy
      await uploadSingleFile(
        activeConnectionId,
        bucket,
        key,
        file,
        (loaded, total) => {
          scheduleProgressUpdate(uploadItem.id, loaded, total);
        },
        abortController.signal
      );
    },
    [scheduleProgressUpdate, activeConnectionId, bucket]
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
      if (!file) {
        throw new Error('File reference is no longer available for upload');
      }
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
          scheduleProgressUpdate(uploadItem.id, loaded, total);
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
    [scheduleProgressUpdate, updateUpload, activeConnectionId, bucket]
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

      if (!uploadItem.file) {
        updateUpload(id, {
          status: 'error',
          error: 'File reference is no longer available. Please re-add the file.',
        });
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

          await uploadMultipartFile(
            uploadItem,
            abortController,
            persistedData?.uploadId ?? uploadItem.uploadId,
            persistedData?.completedParts,
            persistedData?.id ?? uploadItem.persistenceId
          );

          // Remove completed upload from list and update stats
          markCompleted(id, uploadItem.file.size);
        } else {
          await uploadSingleFileWithProxy(uploadItem, abortController);

          // Remove completed upload from list and update stats
          markCompleted(id, uploadItem.file.size);
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
    [updateUpload, markCompleted, uploadMultipartFile, uploadSingleFileWithProxy, refreshPendingUploads]
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

  const writeUploadLock = useCallback(() => {
    if (typeof window === 'undefined') return;
    const lock: UploadLockRecord = {
      id: sessionIdRef.current,
      updatedAt: Date.now(),
      active: true,
    };
    window.localStorage.setItem(UPLOAD_LOCK_KEY, JSON.stringify(lock));
  }, []);

  const upload = useCallback(
    async (files: UploadCandidate[], prefix: string = ''): Promise<void> => {
      const existingLock = readUploadLock();
      if (existingLock) {
        if (isLockStale(existingLock)) {
          if (typeof window !== 'undefined') {
            window.localStorage.removeItem(UPLOAD_LOCK_KEY);
            const refreshedLock = readUploadLock();
            if (!refreshedLock) {
              writeUploadLock();
            }
          }
        } else if (existingLock.active && existingLock.id !== sessionIdRef.current) {
          throw new Error('Uploads are already running in another tab.');
        }
      }
      if (!existingLock && typeof window !== 'undefined') {
        writeUploadLock();
      }
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
          fileName: file.name,
          fileLastModified: file.lastModified,
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
      isLockStale,
      normalizePrefix,
      normalizeRelativePath,
      readUploadLock,
      refreshPendingUploads,
      setUploadsAndSync,
      stripPrefix,
      writeUploadLock,
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
      if (
        uploadItem?.uploadId &&
        uploadItem.isMultipart &&
        uploadItem.status !== 'completed' &&
        activeConnectionId &&
        bucket
      ) {
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

      clearProgressState(id);
      releaseUploadFileReference(id);
      setUploadsAndSync((prev) => prev.filter((u) => u.id !== id));

      if (refresh) {
        void refreshPendingUploads();
      }
    },
    [
      activeConnectionId,
      bucket,
      clearProgressState,
      refreshPendingUploads,
      releaseUploadFileReference,
      removeFromQueue,
      setUploadsAndSync,
    ]
  );

  const cancelUpload = useCallback(
    async (id: string) => {
      await cancelUploadInternal(id, true);
    },
    [cancelUploadInternal]
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

  const cancelAll = useCallback(async () => {
    const idsToCancel = uploadsRef.current
      .filter((upload) => upload.status !== 'completed')
      .map((upload) => upload.id);

    if (idsToCancel.length === 0) return;

    pendingQueueRef.current = [];
    queuedIdsRef.current.clear();

    const results = await Promise.allSettled(
      idsToCancel.map((id) => cancelUploadInternal(id, false))
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      console.error('Failed to cancel some uploads:', failures);
    }
    void refreshPendingUploads();
  }, [cancelUploadInternal, refreshPendingUploads]);

  const clearAll = useCallback(async () => {
    await cancelAll();
    releaseUploadFileReferences();
    resetQueueState();
    setUploadsAndSync(() => []);
    setCompletedStats({ count: 0, size: 0 });
  }, [cancelAll, releaseUploadFileReferences, resetQueueState, setUploadsAndSync]);

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

  const hasActiveUploads = uploads.some((u) => u.status === 'uploading' || u.status === 'pending');

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (hasActiveUploads) {
      writeUploadLock();
      syncUploadBlockState();
      return;
    }

    const lock = readUploadLock();
    if (lock?.id === sessionIdRef.current) {
      window.localStorage.removeItem(UPLOAD_LOCK_KEY);
    }
    syncUploadBlockState();

    if (uploads.length === 0) {
      void clearAllPendingUploads()
        .then(() => setPendingResumable([]))
        .catch((error) => console.error('Failed to clear pending uploads:', error));
    }
  }, [hasActiveUploads, readUploadLock, syncUploadBlockState, uploads.length, writeUploadLock]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!hasActiveUploads) return undefined;

    const intervalId = window.setInterval(() => {
      writeUploadLock();
    }, UPLOAD_LOCK_HEARTBEAT_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasActiveUploads, writeUploadLock]);

  return {
    uploads,
    pendingResumable,
    completedStats,
    upload,
    cancelUpload,
    cancelAll,
    retryUpload,
    clearAll,
    removePendingResumable,
    createNewFolder,
    isUploading: uploads.some((u) => u.status === 'uploading'),
    isUploadBlocked,
  };
}
