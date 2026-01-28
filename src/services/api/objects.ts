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

export async function listObjects(prefix: string = ''): Promise<S3ListResult> {
  const response = await apiGet<ListObjectsResponse>(
    `/objects?prefix=${encodeURIComponent(prefix)}`
  );

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

export async function deleteObject(key: string): Promise<void> {
  await apiDelete(`/objects/${encodeURIComponent(key)}`);
}

export async function createFolder(path: string): Promise<void> {
  await apiPost('/objects/folder', { path });
}
