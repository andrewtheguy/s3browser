import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  getConnectionById,
  getOrCreateIndexedBucket,
  upsertObjectIndexBatch,
  sweepStaleObjects,
  markIndexCompleted,
  type ObjectIndexInput,
} from '../server/db/index.js';
import { createS3ClientFromConnection } from '../server/middleware/auth.js';

type Args = {
  connection?: number;
  bucket?: string;
  batchSize: number;
  dryRun: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { batchSize: 1000, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--connection':
        args.connection = Number(argv[i + 1]);
        i += 1;
        break;
      case '--bucket':
        args.bucket = argv[i + 1];
        i += 1;
        break;
      case '--batch-size':
        args.batchSize = Number(argv[i + 1]);
        i += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
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
  console.log(`Usage: bun run index:keys -- --connection <id> [--bucket <name>]

Crawls every object in an S3 bucket via ListObjectsV2 and stores
(key, last_modified, size, etag) rows in ~/.s3browser/s3browser.db.

The crawl is incremental: rows with the same last_modified are touched
without re-indexing; rows no longer present in the bucket are deleted at
the end of the run. A "last completed" timestamp is recorded on success.

Note: keys are stored unencrypted in the local SQLite DB. The trust
boundary matches the existing object-listing endpoint.

Options:
  --connection <id>     Required. ID of the saved s3 connection (DB primary key).
  --bucket <name>       Bucket to index. Defaults to the connection's saved bucket.
  --batch-size <n>      Objects processed per DB transaction. Default 1000.
  --dry-run             Crawl and count only; do not write to the index.
  -h, --help            Show this help.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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

  const connection = getConnectionById(args.connection);
  if (!connection) {
    console.error(`Connection ${args.connection} not found in DB`);
    process.exit(1);
  }

  const bucket = args.bucket ?? connection.bucket ?? undefined;
  if (!bucket) {
    console.error('No bucket specified and connection has no default bucket');
    process.exit(1);
  }

  console.log(`Indexing s3://${bucket} for connection ${connection.id} (${connection.profile_name})${args.dryRun ? ' [dry-run]' : ''}`);

  const { client } = await createS3ClientFromConnection(connection, bucket);

  const indexedBucketId = args.dryRun ? -1 : getOrCreateIndexedBucket(connection.id, bucket);
  const runStartedAt = Math.floor(Date.now() / 1000);
  const startMs = Date.now();
  const totals = { added: 0, updated: 0, touched: 0, removed: 0, seen: 0 };

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
      const rows: ObjectIndexInput[] = contents.map((item) => {
        const key = item.Key ?? '';
        if (!key) {
          throw new Error('S3 ListObjectsV2 returned a Contents row without a Key');
        }
        if (!item.LastModified) {
          throw new Error(`S3 ListObjectsV2 returned no LastModified for key=${key}`);
        }
        return {
          key,
          lastModified: Math.floor(item.LastModified.getTime() / 1000),
          size: item.Size ?? null,
          etag: item.ETag ?? null,
        };
      });

      totals.seen += rows.length;

      if (!args.dryRun) {
        const result = upsertObjectIndexBatch(indexedBucketId, runStartedAt, rows);
        totals.added += result.added;
        totals.updated += result.updated;
        totals.touched += result.touched;
      }
    }

    if (totals.seen - lastProgressLog >= 5000) {
      lastProgressLog = totals.seen;
      console.log(`Indexed ${totals.seen} keys (page ${pageNumber})...`);
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
}

main().catch((error) => {
  console.error('Indexing failed:', error);
  process.exit(1);
});
