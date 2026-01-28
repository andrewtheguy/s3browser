import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { S3Object, S3ListResult } from '../../types';
import { extractFileName } from '../../utils/formatters';

export interface ListObjectsParams {
  client: S3Client;
  bucket: string;
  prefix?: string;
  continuationToken?: string;
  maxKeys?: number;
}

export async function listObjects({
  client,
  bucket,
  prefix = '',
  continuationToken,
  maxKeys = 1000,
}: ListObjectsParams): Promise<S3ListResult> {
  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    Delimiter: '/',
    ContinuationToken: continuationToken,
    MaxKeys: maxKeys,
  });

  const response = await client.send(command);

  const objects: S3Object[] = [];

  // Add folders (CommonPrefixes)
  if (response.CommonPrefixes) {
    for (const prefix of response.CommonPrefixes) {
      if (prefix.Prefix) {
        objects.push({
          key: prefix.Prefix,
          name: extractFileName(prefix.Prefix),
          isFolder: true,
        });
      }
    }
  }

  // Add files (Contents)
  if (response.Contents) {
    for (const item of response.Contents) {
      if (item.Key && item.Key !== prefix) {
        objects.push({
          key: item.Key,
          name: extractFileName(item.Key),
          size: item.Size,
          lastModified: item.LastModified,
          isFolder: false,
          etag: item.ETag,
        });
      }
    }
  }

  // Sort: folders first, then files, alphabetically
  objects.sort((a, b) => {
    if (a.isFolder && !b.isFolder) return -1;
    if (!a.isFolder && b.isFolder) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    objects,
    continuationToken: response.NextContinuationToken,
    isTruncated: response.IsTruncated ?? false,
  };
}
