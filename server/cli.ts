import './config/configFile.js';
import { Command, InvalidArgumentError } from 'commander';
import { runIndex, runIndexReset } from './cli/indexCommand.js';

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'dev';

function parsePositiveInt(label: string) {
  return (raw: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new InvalidArgumentError(`${label} must be a positive integer`);
    }
    return n;
  };
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

const program = new Command();
program
  .name('s3browser')
  .description('S3-compatible file manager and indexing CLI')
  .version(VERSION);

program
  .command('server')
  .description('Run the HTTP server with embedded frontend assets')
  .option('-b, --bind <addr>', 'Address to bind (e.g. :8170, 127.0.0.1:3000, [::1]:3000)')
  .addHelpText(
    'after',
    `
Encryption Key:
  Required from either env var S3BROWSER_ENCRYPTION_KEY or ~/.s3browser/encryption.key.
  Generate with: openssl rand -hex 32`
  )
  .action(async (opts: { bind?: string }) => {
    // Lazy-load so `--help` and the `index` subcommand don't pull in the
    // embedded frontend asset imports (which only exist after build:client).
    const { runServer } = await import('./cli/serverCommand.js');
    await runServer({ bind: opts.bind });
  });

const indexCmd = program
  .command('index')
  .description('Index an S3 bucket for full-text search')
  .option(
    '-c, --connection <id>',
    'Saved S3 connection ID (DB primary key, required unless --reset is set)',
    parsePositiveInt('--connection')
  )
  .option('--bucket <name>', "Bucket to index (defaults to the connection's saved bucket)")
  .option(
    '--batch-size <n>',
    'Objects processed per S3 page/write loop',
    parsePositiveInt('--batch-size'),
    1000
  )
  .option('--reset', 'Delete the search index database and exit (no crawl)')
  .addHelpText(
    'after',
    `
Crawls every object in an S3 bucket via ListObjectsV2 and stores
(key, last_modified, size, content) rows in ~/.s3browser/s3browser.db.

For text-like objects, the body (up to 2 MB) is downloaded and stored so
the search endpoint can match against file contents via SQLite FTS5.
Eligibility is determined by extension allowlist; if the extension is
unknown, a HEAD request checks for a text/* Content-Type.

The crawl is incremental: rows with the same last_modified are touched
without re-indexing; rows no longer present in the bucket are deleted at
the end of the run.

Use --reset to delete the search index database instead of crawling.`
  )
  .action(
    async (opts: { connection?: number; bucket?: string; batchSize: number; reset?: boolean }, command) => {
      if (opts.reset) {
        runIndexReset();
        return;
      }
      if (opts.connection === undefined) {
        command.error('error: required option \'-c, --connection <id>\' not specified');
      }
      await runIndex({
        connectionId: opts.connection,
        bucket: opts.bucket,
        batchSize: opts.batchSize,
      });
    }
  );

await program.parseAsync(process.argv);
