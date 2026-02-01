import { apiGet, apiDelete, apiPost } from './client';
import type { S3Object } from '../../types';

export interface ListObjectsResponse {
  objects: Array<{
    key: string;
    name: string;
    size?: number;
    lastModified?: string;
    isFolder: boolean;
    etag?: string;
  }>;
  continuationToken?: string;
  isTruncated: boolean;
}

export interface S3ListResult {
  objects: S3Object[];
  continuationToken?: string;
  isTruncated: boolean;
}

export async function listObjects(
  connectionId: number,
  bucket: string,
  prefix: string = '',
  continuationToken?: string,
  signal?: AbortSignal
): Promise<S3ListResult> {
  let url = `/objects/${connectionId}/${encodeURIComponent(bucket)}?prefix=${encodeURIComponent(prefix)}`;
  if (continuationToken) {
    url += `&continuationToken=${encodeURIComponent(continuationToken)}`;
  }
  const response = await apiGet<ListObjectsResponse>(url, signal);

  if (!response || !Array.isArray(response.objects)) {
    throw new Error('Failed to list objects: missing or invalid response');
  }

  // Convert lastModified strings to Date objects
  const objects: S3Object[] = response.objects.map((obj) => ({
    ...obj,
    lastModified: obj.lastModified ? new Date(obj.lastModified) : undefined,
  }));

  return {
    objects,
    continuationToken: response.continuationToken,
    isTruncated: response.isTruncated,
  };
}

export async function deleteObject(connectionId: number, bucket: string, key: string): Promise<void> {
  await apiDelete(`/objects/${connectionId}/${encodeURIComponent(bucket)}?key=${encodeURIComponent(key)}`);
}

export interface BatchDeleteResponse {
  deleted: string[];
  errors: Array<{ key: string; message: string }>;
}

export async function deleteObjects(
  connectionId: number,
  bucket: string,
  keys: string[],
  signal?: AbortSignal
): Promise<BatchDeleteResponse> {
  const response = await apiPost<BatchDeleteResponse>(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/batch-delete`,
    { keys },
    signal
  );

  if (!response) {
    throw new Error('Failed to delete objects: missing response');
  }

  return response;
}

export async function createFolder(connectionId: number, bucket: string, path: string): Promise<void> {
  await apiPost(`/objects/${connectionId}/${encodeURIComponent(bucket)}/folder`, { path });
}
