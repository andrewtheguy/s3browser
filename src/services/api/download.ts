import { apiGet } from './client';

interface DownloadUrlResponse {
  url: string;
}

function validateDownloadUrlResponse(response: DownloadUrlResponse | null, errorPrefix: string): string {
  if (!response) {
    throw new Error(`${errorPrefix}: empty response`);
  }

  const url = response.url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error(`${errorPrefix}: missing or invalid url`);
  }

  try {
    new URL(url);
  } catch {
    throw new Error(`${errorPrefix}: invalid url format`);
  }

  return url;
}

export async function getDownloadUrl(connectionId: number, bucket: string, key: string): Promise<string> {
  if (!Number.isFinite(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }

  const response = await apiGet<DownloadUrlResponse>(
    `/download/${connectionId}/${encodeURIComponent(bucket)}/url?key=${encodeURIComponent(key)}`
  );

  return validateDownloadUrlResponse(response, 'Failed to get download URL');
}

export async function getPresignedUrl(connectionId: number, bucket: string, key: string, ttl: number = 86400): Promise<string> {
  if (!Number.isFinite(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }

  // Validate ttl is a finite positive integer, fallback to default if invalid
  const sanitizedTtl = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 86400;

  const response = await apiGet<DownloadUrlResponse>(
    `/download/${connectionId}/${encodeURIComponent(bucket)}/url?key=${encodeURIComponent(key)}&ttl=${sanitizedTtl}`
  );

  return validateDownloadUrlResponse(response, 'Failed to get presigned URL');
}

export async function downloadFile(connectionId: number, bucket: string, key: string): Promise<void> {
  const url = await getDownloadUrl(connectionId, bucket, key);

  // Extract filename from key
  const filename = key.split('/').pop() || 'download';

  // Create a temporary link and trigger download
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
