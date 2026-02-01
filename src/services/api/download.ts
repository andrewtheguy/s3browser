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
  if (!Number.isInteger(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }

  const response = await apiGet<DownloadUrlResponse>(
    `/download/${connectionId}/${encodeURIComponent(bucket)}/url?key=${encodeURIComponent(key)}&disposition=attachment`
  );

  return validateDownloadUrlResponse(response, 'Failed to get download URL');
}

export async function getPresignedUrl(
  connectionId: number,
  bucket: string,
  key: string,
  ttl: number = 86400,
  disposition?: 'inline' | 'attachment',
  contentType?: string,
  signal?: AbortSignal
): Promise<string> {
  if (!Number.isInteger(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }

  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error('Invalid TTL: must be a positive number');
  }

  const sanitizedTtl = Math.floor(ttl);

  let url = `/download/${connectionId}/${encodeURIComponent(bucket)}/url?key=${encodeURIComponent(key)}&ttl=${sanitizedTtl}`;
  if (disposition) {
    url += `&disposition=${disposition}`;
  }
  if (contentType) {
    url += `&contentType=${encodeURIComponent(contentType)}`;
  }

  const response = await apiGet<DownloadUrlResponse>(url, signal);

  return validateDownloadUrlResponse(response, 'Failed to get presigned URL');
}

export async function downloadFile(connectionId: number, bucket: string, key: string): Promise<void> {
  const url = await getDownloadUrl(connectionId, bucket, key);

  // Extract filename from key
  const filename = key.split('/').pop() || 'download';

  // Create link and attach to DOM for Safari compatibility
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
