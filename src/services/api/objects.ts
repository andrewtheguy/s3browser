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
    isDeleteMarker?: boolean;
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

export async function deleteObject(
  connectionId: number,
  bucket: string,
  key: string,
  versionId?: string
): Promise<void> {
  const params = new URLSearchParams();
  params.append('key', key);
  if (versionId) {
    params.append('versionId', versionId);
  }
  await apiDelete(`/objects/${connectionId}/${encodeURIComponent(bucket)}?${params.toString()}`);
}

export interface BatchDeleteResponse {
  deleted: Array<{ key: string; versionId?: string }>;
  errors: Array<{ key: string; message: string }>;
}

export async function deleteObjects(
  connectionId: number,
  bucket: string,
  keys: Array<{ key: string; versionId?: string }>,
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
  versionId?: string;
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
  versionId?: string,
  signal?: AbortSignal
): Promise<void> {
  await apiPost(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/copy`,
    { sourceKey, destinationKey, versionId },
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
  versionId?: string,
  signal?: AbortSignal
): Promise<void> {
  await apiPost(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/move`,
    { sourceKey, destinationKey, versionId },
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

/**
 * Fetches folders that have live (non-deleted) content.
 * Used to determine which folders are "effectively deleted" when viewing versions.
 * Returns a Set of folder keys that have live content.
 *
 * @param maxItems - Cap on items to fetch. Should be set to the aggregated count from
 * the versioned listing. The non-versioned listing will typically return fewer items
 * since it doesn't include multiple versions of the same file.
 *
 * LIMITATION: This only fetches up to maxItems from the start of the listing.
 * For browse windows beyond the first (e.g., items 5001+), this check is skipped
 * entirely and folders appear as live. This is an acceptable trade-off since
 * viewing versions beyond the first window is a rare edge case.
 */
export async function listLiveFolders(
  connectionId: number,
  bucket: string,
  prefix: string = '',
  maxItems: number,
  signal?: AbortSignal
): Promise<Set<string>> {
  const liveFolders = new Set<string>();
  let continuationToken: string | undefined;
  let itemCount = 0;

  do {
    let url = `/objects/${connectionId}/${encodeURIComponent(bucket)}?prefix=${encodeURIComponent(prefix)}`;
    if (continuationToken) {
      url += `&continuationToken=${encodeURIComponent(continuationToken)}`;
    }

    const response = await apiGet<ListObjectsResponse>(url, signal);

    if (!response || !Array.isArray(response.objects)) {
      const diagnostics = (() => {
        if (!response) {
          return 'response=null';
        }
        if (typeof response !== 'object') {
          return `response=${String(response)}`;
        }
        if ('status' in response) {
          return `response.status=${String((response as { status?: unknown }).status)}`;
        }
        try {
          return `response=${JSON.stringify(response)}`;
        } catch {
          return 'response=[unserializable]';
        }
      })();
      throw new Error(`Failed to list live folders: missing or invalid response (${diagnostics})`);
    }

    // Extract folder keys
    for (const obj of response.objects) {
      if (obj.isFolder) {
        liveFolders.add(obj.key);
      }
    }

    itemCount += response.objects.length;
    if (itemCount >= maxItems) {
      break;
    }

    continuationToken = response.isTruncated ? response.continuationToken : undefined;
  } while (continuationToken);

  return liveFolders;
}

export interface ObjectMetadata {
  key: string;
  size?: number;
  lastModified?: string;
  contentType?: string;
  etag?: string;
  versionId?: string;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
  sseCustomerAlgorithm?: string;
  storageClass?: string;
  vendor?: 'aws' | 'b2' | 'other';
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  userMetadata?: Record<string, string>;
}

export async function getObjectMetadata(
  connectionId: number,
  bucket: string,
  key: string,
  versionId?: string,
  signal?: AbortSignal
): Promise<ObjectMetadata> {
  const params = new URLSearchParams();
  params.append('key', key);
  if (versionId) {
    params.append('versionId', versionId);
  }
  const response = await apiGet<ObjectMetadata>(
    `/objects/${connectionId}/${encodeURIComponent(bucket)}/metadata?${params.toString()}`,
    signal
  );

  if (!response) {
    throw new Error('Failed to get object metadata: missing response');
  }

  return response;
}
