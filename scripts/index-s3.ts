import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import {
  findObjectIndexRowsByKeys,
  getConnectionById,
  getOrCreateIndexedBucket,
  resetObjectIndexTables,
  upsertObjectIndexBatch,
  sweepStaleObjects,
  markIndexCompleted,
  type ObjectIndexInput,
} from '../server/db/index.js';
import { createS3ClientFromConnection } from '../server/middleware/auth.js';
import {
  getEffectiveEndpointHost,
  getSearchWhitelistHosts,
  SEARCH_WHITELIST_ENV_VAR,
} from '../server/config/searchWhitelist.js';

const DEFAULT_MAX_CONTENT_BYTES = 1 * 1024 * 1024;
const BODY_FETCH_CONCURRENCY = 8;

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

type Args = {
  connection?: number;
  bucket?: string;
  batchSize: number;
  maxContentBytes: number;
  noContent: boolean;
  dryRun: boolean;
  reindex: boolean;
  help: boolean;
  error?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    batchSize: 1000,
    maxContentBytes: DEFAULT_MAX_CONTENT_BYTES,
    noContent: false,
    dryRun: false,
    reindex: false,
    help: false,
  };
  const readValue = (flag: string, value: string | undefined): string | undefined => {
    if (!value || value.startsWith('-')) {
      args.error = `${flag} requires a value`;
      return undefined;
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--connection': {
        const value = readValue(arg, argv[i + 1]);
        if (!value) return args;
        args.connection = Number(value);
        i += 1;
        break;
      }
      case '--bucket': {
        const value = readValue(arg, argv[i + 1]);
        if (!value) return args;
        args.bucket = value;
        i += 1;
        break;
      }
      case '--batch-size': {
        const value = readValue(arg, argv[i + 1]);
        if (!value) return args;
        args.batchSize = Number(value);
        i += 1;
        break;
      }
      case '--max-content-bytes': {
        const value = readValue(arg, argv[i + 1]);
        if (!value) return args;
        args.maxContentBytes = Number(value);
        i += 1;
        break;
      }
      case '--no-content':
        args.noContent = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--reindex':
        args.reindex = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: bun run index -- --connection <id> [--bucket <name>]

Crawls every object in an S3 bucket via ListObjectsV2 and stores
(key, last_modified, size, content) rows in ~/.s3browser/s3browser.db.

For text-like objects, the body (up to 1 MB by default) is downloaded and
stored so the search endpoint can match against file contents via SQLite
FTS5. Eligibility is determined by extension allowlist; if the extension
is unknown, a HEAD request checks for a text/* Content-Type.

The crawl is incremental: rows with the same last_modified are touched
without re-indexing; rows no longer present in the bucket are deleted at
the end of the run. Body fetches are skipped for rows with the same
last_modified timestamp.

Options:
  --connection <id>          Required. ID of the saved s3 connection (DB primary key).
  --bucket <name>            Bucket to index. Defaults to the connection's saved bucket.
  --batch-size <n>           Objects processed per DB transaction. Default 1000.
  --max-content-bytes <n>    Per-object body cap in bytes. Default ${DEFAULT_MAX_CONTENT_BYTES}.
  --no-content               Skip content indexing entirely (keys-only).
  --dry-run                  Crawl and count only; do not write to the index.
  --reindex                  Drop and recreate all search index tables before crawling.
  -h, --help                 Show this help.
`);
}

interface PendingRow {
  input: ObjectIndexInput;
  needsBodyFetch: boolean;
  needsHeadCheck: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.error) {
    console.error(args.error);
    printHelp();
    process.exit(1);
  }

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.connection || !Number.isFinite(args.connection) || args.connection <= 0) {
    console.error('Missing or invalid --connection <id>');
    printHelp();
    process.exit(1);
  }

  if (!Number.isFinite(args.batchSize) || args.batchSize <= 0) {
    console.error('Invalid --batch-size value');
    process.exit(1);
  }

  if (!Number.isFinite(args.maxContentBytes) || args.maxContentBytes <= 0) {
    console.error('Invalid --max-content-bytes value');
    process.exit(1);
  }

  if (args.reindex && args.dryRun) {
    console.error('Cannot combine --reindex with --dry-run');
    process.exit(1);
  }

  const connection = getConnectionById(args.connection);
  if (!connection) {
    console.error(`Connection ${args.connection} not found in DB`);
    process.exit(1);
  }

  const endpointHost = getEffectiveEndpointHost(connection.endpoint);
  if (!endpointHost || !getSearchWhitelistHosts().has(endpointHost)) {
    if (!endpointHost) {
      console.error(
        `Refusing to index: connection ${connection.id} has no explicit endpoint set. ` +
          `Set the endpoint URL on the connection and add its host to ${SEARCH_WHITELIST_ENV_VAR}.`
      );
    } else {
      console.error(
        `Refusing to index: connection ${connection.id} endpoint host "${endpointHost}" is not in ${SEARCH_WHITELIST_ENV_VAR}.`
      );
      console.error('Add it to the comma-separated list and retry, e.g.:');
      console.error(`  ${SEARCH_WHITELIST_ENV_VAR}="${endpointHost}" bun run index -- --connection ${connection.id}`);
    }
    process.exit(1);
  }

  const bucket = args.bucket ?? connection.bucket ?? undefined;
  if (!bucket) {
    console.error('No bucket specified and connection has no default bucket');
    process.exit(1);
  }

  const contentMode = args.noContent ? '[no-content]' : `[content cap=${args.maxContentBytes}]`;
  console.log(`Indexing s3://${bucket} for connection ${connection.id} (${connection.profile_name}) ${contentMode}${args.dryRun ? ' [dry-run]' : ''}`);

  const { client } = await createS3ClientFromConnection(connection, bucket);

  if (args.reindex) {
    console.log('Dropping and recreating search index tables...');
    resetObjectIndexTables();
  }

  const indexedBucketId = args.dryRun ? -1 : getOrCreateIndexedBucket(connection.id, bucket);
  const runStartedAt = Math.floor(Date.now() / 1000);
  const startMs = Date.now();
  const totals = {
    added: 0, updated: 0, touched: 0, removed: 0, seen: 0,
    bodyFetched: 0, bodySkippedUnchanged: 0, bodySkippedNonText: 0, bodySkippedSize: 0,
  };

  let continuationToken: string | undefined;
  let pageNumber = 0;
  let lastProgressLog = 0;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: args.batchSize,
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
        if (!args.noContent && !key.endsWith('/') && size !== 0) {
          if (hasTextExtension(key)) {
            if (size !== null && size > args.maxContentBytes) {
              totals.bodySkippedSize += 1;
            } else {
              needsBodyFetch = true;
            }
          } else if (size === null || size <= args.maxContentBytes) {
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
      const existing = args.dryRun
        ? new Map()
        : findObjectIndexRowsByKeys(indexedBucketId, pending.map((p) => p.input.key));

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
        const text = await fetchTextBody(client, bucket, row.input.key, args.maxContentBytes);
        if (text !== null) {
          row.input.content = text;
          totals.bodyFetched += 1;
        }
      });

      if (!args.dryRun) {
        const rows = pending.map((p) => p.input);
        const result = upsertObjectIndexBatch(indexedBucketId, runStartedAt, rows);
        totals.added += result.added;
        totals.updated += result.updated;
        totals.touched += result.touched;
      }
    }

    if (totals.seen - lastProgressLog >= 5000) {
      lastProgressLog = totals.seen;
      console.log(`Indexed ${totals.seen} keys (page ${pageNumber}, bodies fetched ${totals.bodyFetched})...`);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  if (!args.dryRun) {
    totals.removed = sweepStaleObjects(indexedBucketId, runStartedAt);
    markIndexCompleted(indexedBucketId, totals.seen);
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(
    `Done. Indexed ${totals.seen} keys (added=${totals.added}, updated=${totals.updated}, touched=${totals.touched}, removed=${totals.removed}) in ${elapsed}s`
  );
  if (!args.noContent) {
    console.log(
      `Content: fetched=${totals.bodyFetched}, skipped(unchanged)=${totals.bodySkippedUnchanged}, skipped(non-text)=${totals.bodySkippedNonText}, skipped(over-cap)=${totals.bodySkippedSize}`
    );
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('Indexing failed (unhandled promise rejection):', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('Indexing failed (uncaught exception):', err);
  process.exit(1);
});

main().catch((error) => {
  console.error('Indexing failed:', error);
  process.exit(1);
});
