import { apiPost } from './client';
import { UPLOAD_CONFIG } from '../../config/upload';

export interface InitiateUploadResponse {
  uploadId: string;
  key: string;
  totalParts: number;
  partSize: number;
}

export interface UploadPartResponse {
  etag: string;
}

export interface UploadSingleResponse {
  success: boolean;
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
  onPartComplete?: (partNumber: number, etag: string, completedParts: number, totalParts: number) => void | Promise<void>;
  onInitiated?: (uploadId: string, sanitizedKey: string) => void;
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


interface XhrUploadOptions {
  url: string;
  body: Blob | File;
  contentType: string;
  onProgress?: (loaded: number, total: number) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_UPLOAD_TIMEOUT = 300000; // 5 minutes

/**
 * Shared XHR upload helper with abort, progress, and timeout handling
 */
function performXhrUpload({
  url,
  body,
  contentType,
  onProgress,
  abortSignal,
  timeoutMs = DEFAULT_UPLOAD_TIMEOUT,
}: XhrUploadOptions): Promise<string> {
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

    // Handle abort signal
    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler);
      if (abortSignal.aborted) {
        cleanup();
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
    }

    // Progress tracking
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded, event.total);
      }
    });

    // Success handler
    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    // Error handler
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new Error('Network error during upload'));
    });

    // Abort handler
    xhr.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Upload aborted', 'AbortError'));
    });

    // Timeout handler
    xhr.addEventListener('timeout', () => {
      cleanup();
      reject(new Error('Upload timed out'));
    });

    // Send request
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.send(body);
  });
}

/**
 * Upload a single part through the server proxy
 */
export async function uploadPart(
  uploadId: string,
  key: string,
  partNumber: number,
  chunk: Blob,
  onProgress?: (loaded: number, total: number) => void,
  abortSignal?: AbortSignal
): Promise<string> {
  const params = new URLSearchParams({
    uploadId,
    key,
    partNumber: String(partNumber),
  });

  const responseText = await performXhrUpload({
    url: `/api/upload/part?${params.toString()}`,
    body: chunk,
    contentType: 'application/octet-stream',
    onProgress,
    abortSignal,
  });

  let response: UploadPartResponse;
  try {
    response = JSON.parse(responseText) as UploadPartResponse;
  } catch (parseError) {
    throw new Error('Invalid response from server', { cause: parseError });
  }

  if (!response.etag) {
    throw new Error('No ETag in response');
  }
  return response.etag;
}

/**
 * Upload a small file through the server proxy
 */
export async function uploadSingleFile(
  key: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
  abortSignal?: AbortSignal
): Promise<void> {
  const params = new URLSearchParams({ key });

  await performXhrUpload({
    url: `/api/upload/single?${params.toString()}`,
    body: file,
    contentType: file.type || 'application/octet-stream',
    onProgress,
    abortSignal,
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
  // Sort parts by partNumber in ascending order (S3 requires deterministic ordering)
  const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);

  const response = await apiPost<{ success: boolean; key: string }>('/upload/complete', {
    uploadId,
    key,
    parts: sortedParts,
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

      const etag = await uploadPart(uploadId, key, partNumber, chunk, onProgress, abortSignal);
      return etag;
    } catch (error) {
      // Don't retry abort errors
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

      lastError = error instanceof Error ? error : new Error(String(error));

      // Wait before retry (exponential backoff with jitter) with abort awareness
      if (attempt < maxRetries - 1) {
        const delayMs = Math.pow(2, attempt) * 1000;
        // Add jitter (±50%) to prevent thundering herd
        const jitterFactor = 0.5 + Math.random() * 0.5;
        const jitteredDelayMs = Math.floor(delayMs * jitterFactor);

        // Check if already aborted before sleeping
        if (abortSignal?.aborted) {
          throw new DOMException('Upload aborted', 'AbortError');
        }

        // Abort-aware delay
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            cleanup();
            resolve();
          }, jitteredDelayMs);

          const abortHandler = () => {
            clearTimeout(timeoutId);
            cleanup();
            reject(new DOMException('Upload aborted', 'AbortError'));
          };

          const cleanup = () => {
            abortSignal?.removeEventListener('abort', abortHandler);
          };

          abortSignal?.addEventListener('abort', abortHandler);
        });
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
  onInitiated,
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

  // Notify caller of initialized upload (for persistence tracking)
  if (onInitiated) {
    onInitiated(uploadId, sanitizedKey);
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
  const errors: Array<{ partNumber: number; error: Error }> = [];

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
          try {
            await onPartComplete(partNumber, etag, completedParts.length, totalParts);
          } catch (err) {
            // Log but don't fail the upload - persistence is for resume capability
            console.error('onPartComplete callback failed:', err);
          }
        }

        if (onProgress) {
          onProgress(calculateTotalProgress(), fileSize);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        errors.push({
          partNumber,
          error: error instanceof Error ? error : new Error(String(error)),
        });
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
    const failedParts = errors.map((e) => `part ${e.partNumber}: ${e.error.message}`);
    throw new Error(
      `Failed to upload ${errors.length} part(s):\n${failedParts.join('\n')}`
    );
  }

  // Complete the upload
  await completeUpload(uploadId, sanitizedKey, completedParts);

  return {
    uploadId,
    key: sanitizedKey,
    completedParts,
  };
}
