import { apiPost } from './client';
import { UPLOAD_CONFIG } from '../../config/upload';

export interface InitiateUploadResponse {
  uploadId: string;
  key: string;
  totalParts: number;
  partSize: number;
}

export interface PresignResponse {
  url: string;
  partNumber: number;
}

export interface PresignSingleResponse {
  url: string;
  key: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface UploadPartProgress {
  partNumber: number;
  loaded: number;
  total: number;
}

export interface MultipartUploadOptions {
  file: File;
  key: string;
  onProgress?: (loaded: number, total: number, partProgress?: UploadPartProgress) => void;
  onPartComplete?: (partNumber: number, etag: string, completedParts: number, totalParts: number) => void;
  abortSignal?: AbortSignal;
  existingUploadId?: string;
  existingParts?: CompletedPart[];
}

/**
 * Initiate a multipart upload
 */
export async function initiateUpload(
  key: string,
  contentType: string,
  fileSize: number
): Promise<InitiateUploadResponse> {
  const response = await apiPost<InitiateUploadResponse>('/upload/initiate', {
    key,
    contentType,
    fileSize,
  });
  if (!response) {
    throw new Error('Failed to initiate multipart upload');
  }
  return response;
}

/**
 * Get a presigned URL for a specific part
 */
export async function getPartPresignedUrl(
  uploadId: string,
  key: string,
  partNumber: number
): Promise<PresignResponse> {
  const response = await apiPost<PresignResponse>('/upload/presign', {
    uploadId,
    key,
    partNumber,
  });
  if (!response) {
    throw new Error('Failed to get presigned URL for part');
  }
  return response;
}

/**
 * Get a presigned URL for single-part upload (small files)
 */
export async function getPresignedSingleUrl(
  key: string,
  contentType: string,
  fileSize: number
): Promise<PresignSingleResponse> {
  const response = await apiPost<PresignSingleResponse>('/upload/presign-single', {
    key,
    contentType,
    fileSize,
  });
  if (!response) {
    throw new Error('Failed to get presigned URL');
  }
  return response;
}

/**
 * Upload a single part using XHR for progress tracking
 */
export function uploadPart(
  url: string,
  chunk: Blob,
  onProgress?: (loaded: number, total: number) => void,
  abortSignal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const abortHandler = () => {
      xhr.abort();
    };

    const cleanup = () => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler);
      if (abortSignal.aborted) {
        cleanup();
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
    }

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded, event.total);
      }
    });

    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        // Get ETag from response headers
        const etag = xhr.getResponseHeader('ETag');
        if (etag) {
          resolve(etag);
        } else {
          reject(new Error('No ETag in response'));
        }
      } else {
        reject(new Error(`Part upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => {
      cleanup();
      reject(new Error('Network error during part upload'));
    });

    xhr.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Upload aborted', 'AbortError'));
    });

    xhr.open('PUT', url);
    xhr.send(chunk);
  });
}

/**
 * Upload a small file using a single presigned URL
 */
export function uploadSingleFile(
  url: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
  abortSignal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const abortHandler = () => {
      xhr.abort();
    };

    const cleanup = () => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler);
      if (abortSignal.aborted) {
        cleanup();
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
    }

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded, event.total);
      }
    });

    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => {
      cleanup();
      reject(new Error('Network error during upload'));
    });

    xhr.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Upload aborted', 'AbortError'));
    });

    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.send(file);
  });
}

/**
 * Complete a multipart upload
 */
export async function completeUpload(
  uploadId: string,
  key: string,
  parts: CompletedPart[]
): Promise<{ success: boolean; key: string }> {
  const response = await apiPost<{ success: boolean; key: string }>('/upload/complete', {
    uploadId,
    key,
    parts,
  });
  if (!response) {
    throw new Error('Failed to complete multipart upload');
  }
  return response;
}

/**
 * Abort a multipart upload
 */
export async function abortUpload(
  uploadId: string,
  key: string
): Promise<{ success: boolean }> {
  const response = await apiPost<{ success: boolean }>('/upload/abort', {
    uploadId,
    key,
  });
  if (!response) {
    throw new Error('Failed to abort multipart upload');
  }
  return response;
}

/**
 * Upload a part with retry logic
 */
async function uploadPartWithRetry(
  uploadId: string,
  key: string,
  partNumber: number,
  chunk: Blob,
  onProgress?: (loaded: number, total: number) => void,
  abortSignal?: AbortSignal,
  maxRetries: number = UPLOAD_CONFIG.MAX_RETRIES
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Check for abort before each attempt
      if (abortSignal?.aborted) {
        throw new DOMException('Upload aborted', 'AbortError');
      }

      // Get fresh presigned URL for each attempt (they may expire)
      const { url } = await getPartPresignedUrl(uploadId, key, partNumber);
      const etag = await uploadPart(url, chunk, onProgress, abortSignal);
      return etag;
    } catch (error) {
      // Don't retry abort errors
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

      lastError = error instanceof Error ? error : new Error(String(error));

      // Wait before retry (exponential backoff)
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }

  throw lastError || new Error('Upload failed after retries');
}

/**
 * Orchestrate a multipart upload with concurrency control
 */
export async function uploadFileMultipart({
  file,
  key,
  onProgress,
  onPartComplete,
  abortSignal,
  existingUploadId,
  existingParts = [],
}: MultipartUploadOptions): Promise<{
  uploadId: string;
  key: string;
  completedParts: CompletedPart[];
}> {
  const contentType = file.type || 'application/octet-stream';
  const fileSize = file.size;
  const partSize = UPLOAD_CONFIG.PART_SIZE;
  const totalParts = Math.ceil(fileSize / partSize);

  // Initiate upload or resume existing
  let uploadId: string;
  let sanitizedKey: string;

  if (existingUploadId) {
    uploadId = existingUploadId;
    sanitizedKey = key; // Key should already be sanitized for resumed uploads
  } else {
    const initResponse = await initiateUpload(key, contentType, fileSize);
    uploadId = initResponse.uploadId;
    sanitizedKey = initResponse.key;
  }

  // Track completed parts
  const completedParts: CompletedPart[] = [...existingParts];
  const completedPartNumbers = new Set(existingParts.map((p) => p.partNumber));

  // Track progress per part
  const partProgress = new Map<number, number>();
  for (let i = 1; i <= totalParts; i++) {
    // Mark already completed parts as 100% done
    if (completedPartNumbers.has(i)) {
      const start = (i - 1) * partSize;
      const end = Math.min(i * partSize, fileSize);
      partProgress.set(i, end - start);
    } else {
      partProgress.set(i, 0);
    }
  }

  // Calculate and report initial progress for resumed uploads
  const calculateTotalProgress = () => {
    let totalLoaded = 0;
    for (const loaded of partProgress.values()) {
      totalLoaded += loaded;
    }
    return totalLoaded;
  };

  // Parts that need to be uploaded
  const pendingParts: number[] = [];
  for (let i = 1; i <= totalParts; i++) {
    if (!completedPartNumbers.has(i)) {
      pendingParts.push(i);
    }
  }

  // Report initial progress
  if (onProgress) {
    onProgress(calculateTotalProgress(), fileSize);
  }

  // Concurrent upload with pool
  const concurrency = UPLOAD_CONFIG.CONCURRENCY;
  let index = 0;
  const errors: Error[] = [];

  const uploadNext = async (): Promise<void> => {
    while (index < pendingParts.length) {
      // Check for abort
      if (abortSignal?.aborted) {
        return;
      }

      const currentIndex = index++;
      const partNumber = pendingParts[currentIndex];
      const start = (partNumber - 1) * partSize;
      const end = Math.min(partNumber * partSize, fileSize);
      const chunk = file.slice(start, end);

      try {
        const etag = await uploadPartWithRetry(
          uploadId,
          sanitizedKey,
          partNumber,
          chunk,
          (loaded) => {
            partProgress.set(partNumber, loaded);
            if (onProgress) {
              onProgress(calculateTotalProgress(), fileSize, {
                partNumber,
                loaded,
                total: end - start,
              });
            }
          },
          abortSignal
        );

        // Mark part as complete
        partProgress.set(partNumber, end - start);
        completedParts.push({ partNumber, etag });
        completedPartNumbers.add(partNumber);

        if (onPartComplete) {
          onPartComplete(partNumber, etag, completedParts.length, totalParts);
        }

        if (onProgress) {
          onProgress(calculateTotalProgress(), fileSize);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  // Start concurrent uploads
  const workers = Array(Math.min(concurrency, pendingParts.length))
    .fill(null)
    .map(() => uploadNext());

  await Promise.all(workers);

  // Check if aborted
  if (abortSignal?.aborted) {
    throw new DOMException('Upload aborted', 'AbortError');
  }

  // Check for errors
  if (errors.length > 0) {
    throw new Error(`Failed to upload ${errors.length} parts: ${errors[0].message}`);
  }

  // Complete the upload
  await completeUpload(uploadId, sanitizedKey, completedParts);

  return {
    uploadId,
    key: sanitizedKey,
    completedParts,
  };
}
