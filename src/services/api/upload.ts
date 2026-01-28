export interface UploadOptions {
  file: File;
  key: string;
  onProgress?: (loaded: number, total: number) => void;
  abortSignal?: AbortSignal;
}

export function uploadFile({
  file,
  key,
  onProgress,
  abortSignal,
}: UploadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    // Handle abort signal
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        xhr.abort();
        reject(new DOMException('Upload aborted', 'AbortError'));
      });
    }

    // Progress tracking
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded, event.total);
      }
    });

    // Success handler
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        try {
          const error = JSON.parse(xhr.responseText);
          reject(new Error(error.error || 'Upload failed'));
        } catch {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      }
    });

    // Error handler
    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'));
    });

    // Abort handler
    xhr.addEventListener('abort', () => {
      reject(new DOMException('Upload aborted', 'AbortError'));
    });

    // Build FormData
    const formData = new FormData();
    formData.append('file', file);
    formData.append('key', key);

    // Send request
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;
    xhr.send(formData);
  });
}
