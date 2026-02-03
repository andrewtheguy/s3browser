import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { listObjects } from '../services/api';
import type { S3Object } from '../types';

export interface ResolveObjectPlanOptions {
  includeFolderContents?: boolean;
  includeVersions?: boolean;
  signal?: AbortSignal;
  onContinuationPrompt?: (currentCount: number) => boolean | Promise<boolean>;
  continuationPromptEvery?: number;
  continuationPromptStartAt?: number;
}

export interface ObjectPlan {
  fileKeys: Array<{ key: string; versionId?: string }>;
  folderKeys: string[];
}

const CONTINUATION_PROMPT_EVERY = 10_000;
const buildCompositeKey = (key: string, versionId?: string, includeVersions?: boolean): string => {
  if (!includeVersions) {
    return `${key}::`;
  }
  return `${key}::${versionId ?? ''}`;
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

export function useResolveObjectPlan() {
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;

  const resolveObjectPlan = useCallback(
    async (items: S3Object[], options: ResolveObjectPlanOptions = {}): Promise<ObjectPlan> => {
      if (!isConnected || !activeConnectionId || !bucket) {
        throw new Error('Not connected to S3');
      }

      const includeFolderContents = options.includeFolderContents ?? false;
      const includeVersions = options.includeVersions ?? false;
      const fileKeys = new Map<string, { key: string; versionId?: string }>();
      const folderKeys = new Set<string>();
      const queue: string[] = [];
      const promptEvery = Math.max(
        options.continuationPromptEvery ?? CONTINUATION_PROMPT_EVERY,
        1
      );
      const promptStartAt = Math.max(
        options.continuationPromptStartAt ?? promptEvery,
        1
      );
      let nextContinuationPromptAt = promptStartAt;

      for (const item of items) {
        if (item.isFolder) {
          if (includeFolderContents) {
            if (!folderKeys.has(item.key)) {
              folderKeys.add(item.key);
              queue.push(item.key);
            }
          }
        } else {
          fileKeys.set(buildCompositeKey(item.key, item.versionId, includeVersions), {
            key: item.key,
            versionId: includeVersions ? item.versionId : undefined,
          });
        }
      }

      if (!includeFolderContents || queue.length === 0) {
        return { fileKeys: Array.from(fileKeys.values()), folderKeys: [] };
      }

      while (queue.length > 0) {
        const prefix = queue.shift();
        if (!prefix) {
          continue;
        }

        let continuationToken: string | undefined = undefined;
        do {
          throwIfAborted(options.signal);
          const result = await listObjects(
            activeConnectionId,
            bucket,
            prefix,
            includeVersions,
            continuationToken,
            options.signal
          );
          for (const obj of result.objects) {
            if (obj.isFolder) {
              if (!folderKeys.has(obj.key)) {
                folderKeys.add(obj.key);
                queue.push(obj.key);
              }
            } else {
              fileKeys.set(buildCompositeKey(obj.key, obj.versionId, includeVersions), {
                key: obj.key,
                versionId: includeVersions ? obj.versionId : undefined,
              });
            }
          }
          continuationToken = result.isTruncated ? result.continuationToken : undefined;

          if (
            fileKeys.size >= nextContinuationPromptAt &&
            (continuationToken || queue.length > 0)
          ) {
            const shouldContinue = await Promise.resolve(
              options.onContinuationPrompt?.(fileKeys.size) ?? true
            );
            if (!shouldContinue) {
              return { fileKeys: Array.from(fileKeys.values()), folderKeys: Array.from(folderKeys) };
            }
            nextContinuationPromptAt += promptEvery;
          }
        } while (continuationToken);
      }

      return { fileKeys: Array.from(fileKeys.values()), folderKeys: Array.from(folderKeys) };
    },
    [isConnected, activeConnectionId, bucket]
  );

  return { resolveObjectPlan };
}
