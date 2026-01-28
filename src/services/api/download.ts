import { apiGet } from './client';

interface DownloadUrlResponse {
  url: string;
}

export async function getDownloadUrl(key: string): Promise<string> {
  const response = await apiGet<DownloadUrlResponse>(
    `/download/url?key=${encodeURIComponent(key)}`
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

export async function downloadFile(key: string): Promise<void> {
  const url = await getDownloadUrl(key);

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
