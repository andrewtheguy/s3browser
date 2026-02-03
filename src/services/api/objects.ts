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
    versionId?: string;
    isLatest?: boolean;
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
  includeVersions: boolean,
  continuationToken?: string,
  signal?: AbortSignal
): Promise<S3ListResult> {
  let url = `/objects/${connectionId}/${encodeURIComponent(bucket)}?prefix=${encodeURIComponent(prefix)}`;
  if (continuationToken) {
    url += `&continuationToken=${encodeURIComponent(continuationToken)}`;
  }
  if (includeVersions) {
    url += '&versions=1';
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

export interface SeedTestItemsResponse {
  created: number;
  prefix: string;
}

export async function seedTestItems(
  connectionId: number,
  bucket: string,
  prefix: string
): Promise<SeedTestItemsResponse> {
  const response = await apiPost<SeedTestItemsResponse>(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/seed-test-items`,
    { prefix }
  );

  if (!response) {
    throw new Error('Failed to create test items: missing response');
  }

  return response;
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

export interface CopyMoveOperation {
  sourceKey: string;
  destinationKey: string;
}

export interface BatchCopyMoveResponse {
  successful: string[];
  errors: Array<{ sourceKey: string; message: string; destinationKey?: string }>;
}

export async function copyObject(
  connectionId: number,
  bucket: string,
  sourceKey: string,
  destinationKey: string,
  signal?: AbortSignal
): Promise<void> {
  await apiPost(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/copy`,
    { sourceKey, destinationKey },
    signal
  );
}

export async function copyObjects(
  connectionId: number,
  bucket: string,
  operations: CopyMoveOperation[],
  signal?: AbortSignal
): Promise<BatchCopyMoveResponse> {
  const response = await apiPost<BatchCopyMoveResponse>(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/batch-copy`,
    { operations },
    signal
  );

  if (!response) {
    throw new Error('Failed to copy objects: missing response');
  }

  return response;
}

export async function moveObject(
  connectionId: number,
  bucket: string,
  sourceKey: string,
  destinationKey: string,
  signal?: AbortSignal
): Promise<void> {
  await apiPost(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/move`,
    { sourceKey, destinationKey },
    signal
  );
}

export async function moveObjects(
  connectionId: number,
  bucket: string,
  operations: CopyMoveOperation[],
  signal?: AbortSignal
): Promise<BatchCopyMoveResponse> {
  const response = await apiPost<BatchCopyMoveResponse>(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/batch-move`,
    { operations },
    signal
  );

  if (!response) {
    throw new Error('Failed to move objects: missing response');
  }

  return response;
}

export interface ObjectMetadata {
  key: string;
  size?: number;
  lastModified?: string;
  contentType?: string;
  etag?: string;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
  sseCustomerAlgorithm?: string;
  storageClass?: string;
  vendor?: 'aws' | 'b2' | 'other';
}

export async function getObjectMetadata(
  connectionId: number,
  bucket: string,
  key: string,
  signal?: AbortSignal
): Promise<ObjectMetadata> {
  const response = await apiGet<ObjectMetadata>(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/metadata?key=${encodeURIComponent(key)}`,
    signal
  );

  if (!response) {
    throw new Error('Failed to get object metadata: missing response');
  }

  return response;
}
