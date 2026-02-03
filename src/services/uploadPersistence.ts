import type { CompletedPart } from './api/multipartUpload';

export interface PersistedUpload {
  id: string;
  uploadId: string;
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  key: string;
  sanitizedKey: string;
  contentType: string;
  completedParts: CompletedPart[];
  totalParts: number;
  createdAt: number;
  updatedAt: number;
}

const uploadsById = new Map<string, PersistedUpload>();
const uploadsByFingerprint = new Map<string, Set<string>>();

function generateUploadId(): string {
  return crypto.randomUUID();
}

function fingerprintKey(fileName: string, fileSize: number, fileLastModified: number): string {
  return `${fileName}::${fileSize}::${fileLastModified}`;
}

function indexUpload(upload: PersistedUpload) {
  const key = fingerprintKey(upload.fileName, upload.fileSize, upload.fileLastModified);
  const ids = uploadsByFingerprint.get(key) ?? new Set<string>();
  ids.add(upload.id);
  uploadsByFingerprint.set(key, ids);
}

function unindexUpload(upload: PersistedUpload) {
  const key = fingerprintKey(upload.fileName, upload.fileSize, upload.fileLastModified);
  const ids = uploadsByFingerprint.get(key);
  if (!ids) return;
  ids.delete(upload.id);
  if (ids.size === 0) {
    uploadsByFingerprint.delete(key);
  }
}

/**
 * Save or update an upload state (in-memory only).
 */
export function saveUploadState(
  upload: Omit<PersistedUpload, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<PersistedUpload> {
  const now = Date.now();
  if (upload.id) {
    const existing = uploadsById.get(upload.id);
    if (existing) {
      unindexUpload(existing);
    }
    const persistedUpload: PersistedUpload = {
      ...upload,
      id: upload.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    uploadsById.set(persistedUpload.id, persistedUpload);
    indexUpload(persistedUpload);
    return Promise.resolve(persistedUpload);
  }

  const persistedUpload: PersistedUpload = {
    ...upload,
    id: generateUploadId(),
    createdAt: now,
    updatedAt: now,
  };
  uploadsById.set(persistedUpload.id, persistedUpload);
  indexUpload(persistedUpload);
  return Promise.resolve(persistedUpload);
}

/**
 * Get an upload by its ID.
 */
export function getUploadById(id: string): Promise<PersistedUpload | null> {
  return Promise.resolve(uploadsById.get(id) ?? null);
}

/**
 * Find a resumable upload by file fingerprint.
 */
export function getUploadByFile(
  fileName: string,
  fileSize: number,
  fileLastModified: number
): Promise<PersistedUpload | null> {
  const key = fingerprintKey(fileName, fileSize, fileLastModified);
  const ids = uploadsByFingerprint.get(key);
  if (!ids || ids.size === 0) {
    return Promise.resolve(null);
  }
  for (const id of ids.values()) {
    const upload = uploadsById.get(id);
    if (upload) {
      return Promise.resolve(upload);
    }
  }
  return Promise.resolve(null);
}

/**
 * Delete an upload state.
 */
export function deleteUploadState(id: string): Promise<void> {
  const existing = uploadsById.get(id);
  if (!existing) return Promise.resolve();
  uploadsById.delete(id);
  unindexUpload(existing);
  return Promise.resolve();
}

/**
 * List all pending uploads, sorted by creation time (newest first).
 */
export function listPendingUploads(): Promise<PersistedUpload[]> {
  return Promise.resolve(Array.from(uploadsById.values()).sort((a, b) => b.createdAt - a.createdAt));
}

/**
 * Clear all pending uploads (useful for cleanup).
 */
export function clearAllPendingUploads(): Promise<void> {
  uploadsById.clear();
  uploadsByFingerprint.clear();
  return Promise.resolve();
}

/**
 * Update completed parts for an upload.
 */
export function updateCompletedParts(
  id: string,
  completedParts: CompletedPart[]
): Promise<void> {
  const existing = uploadsById.get(id);
  if (!existing) {
    return Promise.reject(new Error('Upload not found'));
  }
  const updated: PersistedUpload = {
    ...existing,
    completedParts,
    updatedAt: Date.now(),
  };
  uploadsById.set(id, updated);
  return Promise.resolve();
}
