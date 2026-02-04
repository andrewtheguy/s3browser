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

export interface ObjectPlanEntry {
  key: string;
  versionId?: string;
  isLatest?: boolean;
  isDeleteMarker?: boolean;
}

export interface ObjectPlan {
  fileKeys: ObjectPlanEntry[];
  folderKeys: string[];
}

const CONTINUATION_PROMPT_EVERY = 10_000;
const buildCompositeKey = (key: string, versionId?: string): string => {
  return `${key}::${versionId ?? ''}`;
};

function processFolder(
  folder: S3Object,
  fileKeys: Map<string, ObjectPlanEntry>,
  folderPrefixes: Set<string>,
  folderDeleteKeys: Set<string>,
  queue: string[],
  includeVersions: boolean,
  includeFolderContents: boolean
) {
  if (includeVersions && folder.versionId) {
    fileKeys.set(buildCompositeKey(folder.key, folder.versionId), {
      key: folder.key,
      versionId: folder.versionId,
      isLatest: folder.isLatest,
      isDeleteMarker: folder.isDeleteMarker,
    });
  }
  if (!includeFolderContents) {
    return;
  }
  if (!folderPrefixes.has(folder.key)) {
    folderPrefixes.add(folder.key);
    queue.push(folder.key);
  }
  if (!includeVersions) {
    folderDeleteKeys.add(folder.key);
  }
}

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
      const fileKeys = new Map<string, ObjectPlanEntry>();
      const folderPrefixes = new Set<string>();
      const folderDeleteKeys = new Set<string>();
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
          processFolder(
            item,
            fileKeys,
            folderPrefixes,
            folderDeleteKeys,
            queue,
            includeVersions,
            includeFolderContents
          );
        } else {
          const versionId = includeVersions ? item.versionId : undefined;
          fileKeys.set(buildCompositeKey(item.key, versionId), {
            key: item.key,
            versionId,
            isLatest: item.isLatest,
            isDeleteMarker: item.isDeleteMarker,
          });
        }
      }

      if (!includeFolderContents || queue.length === 0) {
        return {
          fileKeys: Array.from(fileKeys.values()),
          folderKeys: includeVersions ? [] : Array.from(folderDeleteKeys),
        };
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
            throwIfAborted(options.signal);
            if (obj.isFolder) {
              processFolder(
                obj,
                fileKeys,
                folderPrefixes,
                folderDeleteKeys,
                queue,
                includeVersions,
                true
              );
            } else {
              const versionId = includeVersions ? obj.versionId : undefined;
              fileKeys.set(buildCompositeKey(obj.key, versionId), {
                key: obj.key,
                versionId,
                isLatest: obj.isLatest,
                isDeleteMarker: obj.isDeleteMarker,
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
              return {
                fileKeys: Array.from(fileKeys.values()),
                folderKeys: includeVersions ? [] : Array.from(folderDeleteKeys),
              };
            }
            nextContinuationPromptAt += promptEvery;
          }
        } while (continuationToken);
      }

      return {
        fileKeys: Array.from(fileKeys.values()),
        folderKeys: includeVersions ? [] : Array.from(folderDeleteKeys),
      };
    },
    [isConnected, activeConnectionId, bucket]
  );

  return { resolveObjectPlan };
}
