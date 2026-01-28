import type { CompletedPart } from './api/multipartUpload';

const DB_NAME = 's3browser-uploads';
const DB_VERSION = 1;
const STORE_NAME = 'pending-uploads';

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

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB'));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        // Index for finding uploads by file fingerprint
        store.createIndex('fileFingerprint', ['fileName', 'fileSize', 'fileLastModified'], {
          unique: false,
        });
        // Index for listing by creation time
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
  });

  return dbPromise;
}

/**
 * Generate a unique ID for a new upload
 */
function generateUploadId(): string {
  return crypto.randomUUID();
}

/**
 * Save or update an upload state
 */
export async function saveUploadState(upload: Omit<PersistedUpload, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<PersistedUpload> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const now = Date.now();
    const persistedUpload: PersistedUpload = {
      ...upload,
      id: upload.id || generateUploadId(),
      createdAt: upload.id ? (undefined as unknown as number) : now, // Will be preserved if updating
      updatedAt: now,
    };

    // If updating, preserve original createdAt
    if (upload.id) {
      const getRequest = store.get(upload.id);
      getRequest.onsuccess = () => {
        const existing = getRequest.result as PersistedUpload | undefined;
        if (existing) {
          persistedUpload.createdAt = existing.createdAt;
        } else {
          persistedUpload.createdAt = now;
        }

        const putRequest = store.put(persistedUpload);
        putRequest.onsuccess = () => resolve(persistedUpload);
        putRequest.onerror = () => reject(new Error('Failed to save upload state'));
      };
      getRequest.onerror = () => reject(new Error('Failed to get existing upload'));
    } else {
      persistedUpload.createdAt = now;
      const request = store.put(persistedUpload);
      request.onsuccess = () => resolve(persistedUpload);
      request.onerror = () => reject(new Error('Failed to save upload state'));
    }
  });
}

/**
 * Get an upload by its ID
 */
export async function getUploadById(id: string): Promise<PersistedUpload | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(new Error('Failed to get upload'));
    };
  });
}

/**
 * Find a resumable upload by file fingerprint
 */
export async function getUploadByFile(
  fileName: string,
  fileSize: number,
  fileLastModified: number
): Promise<PersistedUpload | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('fileFingerprint');
    const request = index.get([fileName, fileSize, fileLastModified]);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(new Error('Failed to find upload by file'));
    };
  });
}

/**
 * Delete an upload state
 */
export async function deleteUploadState(id: string): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('Failed to delete upload state'));
    };
  });
}

/**
 * List all pending uploads, sorted by creation time (newest first)
 */
export async function listPendingUploads(): Promise<PersistedUpload[]> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('createdAt');
    const request = index.openCursor(null, 'prev'); // Descending order

    const uploads: PersistedUpload[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        uploads.push(cursor.value);
        cursor.continue();
      } else {
        resolve(uploads);
      }
    };

    request.onerror = () => {
      reject(new Error('Failed to list pending uploads'));
    };
  });
}

/**
 * Clear all pending uploads (useful for cleanup)
 */
export async function clearAllPendingUploads(): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('Failed to clear pending uploads'));
    };
  });
}

/**
 * Update completed parts for an upload
 */
export async function updateCompletedParts(
  id: string,
  completedParts: CompletedPart[]
): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const upload = getRequest.result as PersistedUpload | undefined;
      if (!upload) {
        reject(new Error('Upload not found'));
        return;
      }

      upload.completedParts = completedParts;
      upload.updatedAt = Date.now();

      const putRequest = store.put(upload);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(new Error('Failed to update completed parts'));
    };

    getRequest.onerror = () => {
      reject(new Error('Failed to get upload for update'));
    };
  });
}
