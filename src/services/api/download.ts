import { apiGet } from './client';

interface DownloadUrlResponse {
  url: string;
}

export async function getDownloadUrl(connectionId: number, bucket: string, key: string): Promise<string> {
  const response = await apiGet<DownloadUrlResponse>(
    `/download/${connectionId}/${encodeURIComponent(bucket)}/url?key=${encodeURIComponent(key)}`
  );
  if (!response) {
    throw new Error('Failed to get download URL: empty response');
  }

  const url = response.url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('Failed to get download URL: missing or invalid url');
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    throw new Error('Failed to get download URL: invalid url format');
  }

  return url;
}

export async function getPresignedUrl(connectionId: number, bucket: string, key: string, ttl: number = 86400): Promise<string> {
  // Validate ttl is a finite positive integer, fallback to default if invalid
  const sanitizedTtl = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 86400;

  const response = await apiGet<DownloadUrlResponse>(
    `/download/${connectionId}/${encodeURIComponent(bucket)}/url?key=${encodeURIComponent(key)}&ttl=${sanitizedTtl}`
  );
  if (!response) {
    throw new Error('Failed to get presigned URL: empty response');
  }

  const url = response.url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('Failed to get presigned URL: missing or invalid url');
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    throw new Error('Failed to get presigned URL: invalid url format');
  }

  return url;
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
