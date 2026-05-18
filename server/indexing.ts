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

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'json', 'jsonc', 'ndjson', 'csv', 'tsv', 'log',
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

async function headIsText(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return isTextContentType(head.ContentType);
  } catch {
    return false;
  }
}

async function fetchTextBody(
  client: S3Client,
  bucket: string,
  key: string,
  maxBytes: number
): Promise<string | null> {
  try {
    const resp = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=0-${maxBytes - 1}`,
    }));
    if (!resp.Body) return null;
    const bytes = await resp.Body.transformToByteArray();
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (err) {
    console.warn(`  warn: failed to fetch body for ${key}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
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
  let lastProgressLog = 0;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: batchSize,
        ContinuationToken: continuationToken,
      })
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
      await runWithConcurrency(headTargets, BODY_FETCH_CONCURRENCY, async (row) => {
        const isText = await headIsText(client, bucket, row.input.key);
        if (isText) {
          row.needsBodyFetch = true;
        } else {
          totals.bodySkippedNonText += 1;
        }
        row.needsHeadCheck = false;
      });

      // Fetch text bodies in parallel.
      const bodyTargets = pending.filter((p) => p.needsBodyFetch);
      await runWithConcurrency(bodyTargets, BODY_FETCH_CONCURRENCY, async (row) => {
        const text = await fetchTextBody(client, bucket, row.input.key, MAX_CONTENT_BYTES);
        if (text !== null) {
          row.input.content = text;
          totals.bodyFetched += 1;
        }
      });

      const rows = pending.map((p) => p.input);
      const result = upsertObjectIndexBatch(indexedBucketId, runStartedAt, rows);
      totals.added += result.added;
      totals.updated += result.updated;
      totals.touched += result.touched;
    }

    if (totals.seen - lastProgressLog >= 5000) {
      lastProgressLog = totals.seen;
      console.log(`Indexed ${totals.seen} keys (page ${pageNumber}, bodies fetched ${totals.bodyFetched})...`);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

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
