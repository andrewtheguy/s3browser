import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import {
  deleteIndexDatabase,
  findObjectIndexRowsByKeys,
  getConnectionById,
  getOrCreateIndexedBucket,
  upsertObjectIndexBatch,
  sweepStaleObjects,
  markIndexCompleted,
  type ObjectIndexInput,
} from './db/index.js';
import { createS3ClientFromConnection } from './middleware/auth.js';
import {
  getEffectiveEndpointHost,
  getSearchWhitelistHosts,
  SEARCH_WHITELIST_ENV_VAR,
} from './config/searchWhitelist.js';

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const BODY_FETCH_CONCURRENCY = 8;
const DEFAULT_BATCH_SIZE = 1000;
const PROGRESS_KEY_INTERVAL = 5000;
const PROGRESS_HEARTBEAT_MS = 15_000;
const HEAD_OBJECT_TIMEOUT_MS = 15_000;
const GET_OBJECT_TIMEOUT_MS = 30_000;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'json', 'jsonc', 'jsonl', 'ndjson', 'csv', 'tsv', 'log',
  'xml', 'html', 'htm', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'tf', 'hcl',
  'gitignore', 'editorconfig', 'lock',
]);

const TEXT_BASENAMES = new Set([
  'readme', 'license', 'licence', 'copying', 'authors', 'changelog',
  'makefile', 'dockerfile', 'jenkinsfile', 'procfile',
]);

const TEXT_APP_TYPES = [
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/ecmascript',
  'application/x-sh',
  'application/x-shellscript',
  'application/sql',
];

function hasTextExtension(key: string): boolean {
  const base = key.split('/').pop() ?? '';
  const lower = base.toLowerCase();
  if (TEXT_BASENAMES.has(lower)) return true;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(lower.slice(dot + 1));
}

function isTextContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  if (lower.startsWith('text/')) return true;
  return TEXT_APP_TYPES.some((t) => lower.startsWith(t));
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatTimeoutMs(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

async function withS3RequestTimeout<T>(
  operation: string,
  key: string,
  timeoutMs: number,
  task: (abortSignal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutError: Error | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      timeoutError = new Error(`${operation} timed out after ${formatTimeoutMs(timeoutMs)} for key=${key}`);
      reject(timeoutError);
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      task(controller.signal),
      timeoutPromise,
    ]);
  } catch (err) {
    if (timedOut && timeoutError) {
      throw timeoutError;
    }
    throw err;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function headIsText(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    const head = await withS3RequestTimeout(
      'HEAD object',
      key,
      HEAD_OBJECT_TIMEOUT_MS,
      (abortSignal) => client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal })
    );
    return isTextContentType(head.ContentType);
  } catch (err) {
    throw new Error(`failed to probe content type for ${key}: ${formatErrorMessage(err)}`, { cause: err });
  }
}

async function fetchTextBody(
  client: S3Client,
  bucket: string,
  key: string,
  maxBytes: number
): Promise<string> {
  try {
    return await withS3RequestTimeout('GET object body', key, GET_OBJECT_TIMEOUT_MS, async (abortSignal) => {
      const resp = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=0-${maxBytes - 1}`,
      }), { abortSignal });
      if (!resp.Body) {
        throw new Error('S3 returned no response body');
      }
      const bytes = await resp.Body.transformToByteArray();
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    });
  } catch (err) {
    throw new Error(`failed to fetch body for ${key}: ${formatErrorMessage(err)}`, { cause: err });
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const runnerCount = Math.min(concurrency, items.length);
  if (runnerCount <= 0) return;

  let next = 0;
  let failed = false;
  let firstError: unknown;

  const runners = Array.from({ length: runnerCount }, async () => {
    while (next < items.length) {
      if (failed) return;
      const i = next++;
      try {
        await worker(items[i], i);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  });

  await Promise.all(runners);
  if (failed) {
    throw firstError;
  }
}

async function withIntervalHeartbeat<T>(
  heartbeat: () => void,
  task: () => Promise<T>
): Promise<T> {
  const interval = setInterval(heartbeat, PROGRESS_HEARTBEAT_MS);
  try {
    return await task();
  } finally {
    clearInterval(interval);
  }
}

interface PendingRow {
  input: ObjectIndexInput;
  needsBodyFetch: boolean;
  needsHeadCheck: boolean;
}

export interface IndexS3BucketOptions {
  connectionId: number;
  bucket?: string;
  batchSize?: number;
}

export interface IndexS3BucketStats {
  added: number;
  updated: number;
  touched: number;
  removed: number;
  seen: number;
  bodyFetched: number;
  bodySkippedUnchanged: number;
  bodySkippedNonText: number;
  bodySkippedSize: number;
  elapsedMs: number;
}

export async function indexS3Bucket(options: IndexS3BucketOptions): Promise<IndexS3BucketStats> {
  const { connectionId } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  if (!Number.isFinite(connectionId) || connectionId <= 0) {
    throw new Error('Missing or invalid connectionId');
  }
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error('Invalid batchSize');
  }

  const connection = getConnectionById(connectionId);
  if (!connection) {
    throw new Error(`Connection ${connectionId} not found in DB`);
  }

  const endpointHost = getEffectiveEndpointHost(connection.endpoint);
  if (!endpointHost || !getSearchWhitelistHosts().has(endpointHost)) {
    if (!endpointHost) {
      throw new Error(
        `Refusing to index: connection ${connection.id} has no explicit endpoint set. ` +
          `Set the endpoint URL on the connection and add its host to ${SEARCH_WHITELIST_ENV_VAR}.`
      );
    }
    throw new Error(
      `Refusing to index: connection ${connection.id} endpoint host "${endpointHost}" is not in ${SEARCH_WHITELIST_ENV_VAR}.`
    );
  }

  const bucket = options.bucket ?? connection.bucket ?? undefined;
  if (!bucket) {
    throw new Error('No bucket specified and connection has no default bucket');
  }

  console.log(`Indexing s3://${bucket} for connection ${connection.id} (${connection.profile_name}) at ${endpointHost}`);

  const { client } = await createS3ClientFromConnection(connection, bucket);

  const indexedBucketId = getOrCreateIndexedBucket(endpointHost, bucket);
  const runStartedAt = Math.floor(Date.now() / 1000);
  const startMs = Date.now();
  const totals: IndexS3BucketStats = {
    added: 0, updated: 0, touched: 0, removed: 0, seen: 0,
    bodyFetched: 0, bodySkippedUnchanged: 0, bodySkippedNonText: 0, bodySkippedSize: 0,
    elapsedMs: 0,
  };

  let continuationToken: string | undefined;
  let pageNumber = 0;
  let lastProgressSeen = 0;
  let lastProgressMs = startMs;

  const logProgress = (phase?: string): void => {
    lastProgressSeen = totals.seen;
    lastProgressMs = Date.now();
    const elapsed = ((lastProgressMs - startMs) / 1000).toFixed(1);
    const pageText = pageNumber > 0 ? `page ${pageNumber}` : 'before first page';
    const phaseText = phase ? `, ${phase}` : '';
    console.log(
      `Indexing progress: ${totals.seen} keys seen (${pageText}, bodies fetched ${totals.bodyFetched}${phaseText}, elapsed ${elapsed}s)...`
    );
  };

  const maybeLogProgress = (phase?: string): void => {
    const now = Date.now();
    if (
      totals.seen - lastProgressSeen >= PROGRESS_KEY_INTERVAL ||
      now - lastProgressMs >= PROGRESS_HEARTBEAT_MS
    ) {
      logProgress(phase);
    }
  };

  do {
    const response = await withIntervalHeartbeat(
      () => maybeLogProgress(`listing page ${pageNumber + 1}`),
      () => client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: batchSize,
          ContinuationToken: continuationToken,
        })
      )
    );

    pageNumber += 1;
    const contents = response.Contents ?? [];

    if (contents.length > 0) {
      const pending: PendingRow[] = contents.map((item) => {
        const key = item.Key ?? '';
        if (!key) {
          throw new Error('S3 ListObjectsV2 returned a Contents row without a Key');
        }
        if (!item.LastModified) {
          throw new Error(`S3 ListObjectsV2 returned no LastModified for key=${key}`);
        }
        const size = item.Size ?? null;
        let needsBodyFetch = false;
        let needsHeadCheck = false;
        if (!key.endsWith('/') && size !== 0) {
          if (hasTextExtension(key)) {
            if (size !== null && size > MAX_CONTENT_BYTES) {
              totals.bodySkippedSize += 1;
            } else {
              needsBodyFetch = true;
            }
          } else if (size === null || size <= MAX_CONTENT_BYTES) {
            needsHeadCheck = true;
          }
        }
        return {
          input: {
            key,
            lastModified: Math.floor(item.LastModified.getTime() / 1000),
            size,
            content: null,
          },
          needsBodyFetch,
          needsHeadCheck,
        };
      });

      totals.seen += pending.length;

      // Skip body work whenever the upsert will land in the "touched" branch
      // (same last_modified), since that branch only updates seen_at and would
      // throw away any body we fetched.
      const existing = findObjectIndexRowsByKeys(indexedBucketId, pending.map((p) => p.input.key));

      for (const row of pending) {
        if (!row.needsBodyFetch && !row.needsHeadCheck) continue;
        const prior = existing.get(row.input.key);
        if (prior && prior.last_modified === row.input.lastModified) {
          row.needsBodyFetch = false;
          row.needsHeadCheck = false;
          totals.bodySkippedUnchanged += 1;
        }
      }

      // HEAD probes for unknown extensions
      const headTargets = pending.filter((p) => p.needsHeadCheck);
      let headChecked = 0;
      await withIntervalHeartbeat(
        () => maybeLogProgress(`checking content types ${headChecked}/${headTargets.length}`),
        () => runWithConcurrency(headTargets, BODY_FETCH_CONCURRENCY, async (row) => {
          const isText = await headIsText(client, bucket, row.input.key);
          if (isText) {
            row.needsBodyFetch = true;
          } else {
            totals.bodySkippedNonText += 1;
          }
          row.needsHeadCheck = false;
          headChecked += 1;
          maybeLogProgress(`checking content types ${headChecked}/${headTargets.length}`);
        })
      );

      // Fetch text bodies in parallel.
      const bodyTargets = pending.filter((p) => p.needsBodyFetch);
      let bodiesFetchedThisPage = 0;
      await withIntervalHeartbeat(
        () => maybeLogProgress(`fetching bodies ${bodiesFetchedThisPage}/${bodyTargets.length}`),
        () => runWithConcurrency(bodyTargets, BODY_FETCH_CONCURRENCY, async (row) => {
          const text = await fetchTextBody(client, bucket, row.input.key, MAX_CONTENT_BYTES);
          row.input.content = text;
          totals.bodyFetched += 1;
          bodiesFetchedThisPage += 1;
          maybeLogProgress(`fetching bodies ${bodiesFetchedThisPage}/${bodyTargets.length}`);
        })
      );

      const rows = pending.map((p) => p.input);
      maybeLogProgress(`writing page ${pageNumber}`);
      const result = upsertObjectIndexBatch(indexedBucketId, runStartedAt, rows);
      totals.added += result.added;
      totals.updated += result.updated;
      totals.touched += result.touched;
    }

    maybeLogProgress(`page ${pageNumber} complete`);

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`Sweeping stale index rows after ${totals.seen} indexed keys...`);
  totals.removed = sweepStaleObjects(indexedBucketId, runStartedAt);
  markIndexCompleted(indexedBucketId, totals.seen);
  totals.elapsedMs = Date.now() - startMs;

  const elapsed = (totals.elapsedMs / 1000).toFixed(1);
  console.log(
    `Done. Indexed ${totals.seen} keys (added=${totals.added}, updated=${totals.updated}, touched=${totals.touched}, removed=${totals.removed}) in ${elapsed}s`
  );
  console.log(
    `Content: fetched=${totals.bodyFetched}, skipped(unchanged)=${totals.bodySkippedUnchanged}, skipped(non-text)=${totals.bodySkippedNonText}, skipped(over-cap)=${totals.bodySkippedSize}`
  );

  return totals;
}

export function resetIndex(): void {
  console.log('Deleting and recreating the search index database...');
  deleteIndexDatabase();
  console.log('Search index database is empty.');
}
