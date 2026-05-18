import { indexS3Bucket, resetIndex } from '../server/indexing.js';

type Args = {
  connection?: number;
  bucket?: string;
  batchSize: number;
  reset: boolean;
  help: boolean;
  error?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    batchSize: 1000,
    reset: false,
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
      case '--reset':
        args.reset = true;
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

For text-like objects, the body (up to 2 MB) is downloaded and stored so
the search endpoint can match against file contents via SQLite FTS5.
Eligibility is determined by extension allowlist; if the extension is
unknown, a HEAD request checks for a text/* Content-Type.

The crawl is incremental: rows with the same last_modified are touched
without re-indexing; rows no longer present in the bucket are deleted at
the end of the run. Body fetches are skipped for rows with the same
last_modified timestamp.

Options:
  --connection <id>          Required (unless --reset). ID of the saved s3 connection (DB primary key).
  --bucket <name>            Bucket to index. Defaults to the connection's saved bucket.
  --batch-size <n>           Objects processed per DB transaction. Default 1000.
  --reset                    Delete the search index database and exit (no crawl).
  -h, --help                 Show this help.
`);
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

  if (args.reset) {
    resetIndex();
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

  await indexS3Bucket({
    connectionId: args.connection,
    bucket: args.bucket,
    batchSize: args.batchSize,
  });
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
  console.error('Indexing failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
