import { apiGet, apiGetText, apiPost } from './client';

interface DownloadUrlResponse {
  url: string;
}

export interface BatchZipEntry {
  key: string;
  versionId?: string;
  name: string;
}

interface BatchZipTicketResponse {
  ticket: string;
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

export async function getPresignedUrl(
  connectionId: number,
  bucket: string,
  key: string,
  ttl: number = 86400,
  options?: {
    disposition?: 'inline' | 'attachment';
    contentType?: string;
    signal?: AbortSignal;
    versionId?: string;
  }
): Promise<string> {
  if (!Number.isInteger(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }

  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error('Invalid TTL: must be a positive number');
  }

  const sanitizedTtl = Math.floor(ttl);

  const basePath = `/download/${connectionId}/${encodeURIComponent(bucket)}/url`;
  const { disposition, contentType, signal, versionId } = options ?? {};
  const params = new URLSearchParams();
  params.append('key', key);
  params.append('ttl', String(sanitizedTtl));
  if (versionId) {
    params.append('versionId', versionId);
  }
  if (disposition) {
    params.append('disposition', disposition);
  }
  if (contentType) {
    params.append('contentType', contentType);
  }
  const url = `${basePath}?${params.toString()}`;

  const response = await apiGet<DownloadUrlResponse>(url, signal);

  return validateDownloadUrlResponse(response, 'Failed to get presigned URL');
}

export function buildObjectUrl(
  connectionId: number,
  bucket: string,
  key: string,
  options?: {
    disposition?: 'inline' | 'attachment';
    contentType?: string;
    versionId?: string;
  }
): string {
  if (!Number.isInteger(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }
  const { disposition, contentType, versionId } = options ?? {};
  const params = new URLSearchParams();
  params.append('key', key);
  if (versionId) params.append('versionId', versionId);
  if (disposition) params.append('disposition', disposition);
  if (contentType) params.append('contentType', contentType);
  return `/api/download/${connectionId}/${encodeURIComponent(bucket)}/object?${params.toString()}`;
}

/**
 * Requests a single-use ticket for a server-side ZIP of many objects. Used as a
 * fallback for browsers without the File System Access API. The resolved key
 * list is POSTed here; the returned ticket is then handed to `buildBatchZipUrl`
 * for a GET navigation that streams the archive to disk.
 */
export async function createBatchZipTicket(
  connectionId: number,
  bucket: string,
  entries: BatchZipEntry[],
  archiveName?: string,
  signal?: AbortSignal
): Promise<string> {
  if (!Number.isInteger(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }
  if (entries.length === 0) {
    throw new Error('No objects to download');
  }

  const endpoint = `/download/${connectionId}/${encodeURIComponent(bucket)}/batch-zip-ticket`;
  const response = await apiPost<BatchZipTicketResponse>(endpoint, { entries, archiveName }, signal);

  const ticket = response?.ticket;
  if (typeof ticket !== 'string' || !ticket.trim()) {
    throw new Error('Failed to prepare download: missing ticket');
  }
  return ticket;
}

export function buildBatchZipUrl(connectionId: number, bucket: string, ticket: string): string {
  if (!Number.isInteger(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }
  const params = new URLSearchParams();
  params.append('ticket', ticket);
  return `/api/download/${connectionId}/${encodeURIComponent(bucket)}/batch-zip?${params.toString()}`;
}

export async function getObjectText(
  connectionId: number,
  bucket: string,
  key: string,
  options?: { signal?: AbortSignal; versionId?: string }
): Promise<string> {
  if (!Number.isInteger(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }

  const params = new URLSearchParams();
  params.append('key', key);
  if (options?.versionId) {
    params.append('versionId', options.versionId);
  }

  const endpoint = `/download/${connectionId}/${encodeURIComponent(bucket)}/object?${params.toString()}`;
  const text = await apiGetText(endpoint, options?.signal);
  return text ?? '';
}
