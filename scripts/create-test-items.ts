import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

type Args = {
  bucket?: string;
  prefix?: string;
  count: number;
  region?: string;
  endpoint?: string;
  concurrency: number;
  forcePathStyle: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    count: 10005,
    concurrency: 25,
    forcePathStyle: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--bucket':
        args.bucket = argv[i + 1];
        i += 1;
        break;
      case '--prefix':
        args.prefix = argv[i + 1];
        i += 1;
        break;
      case '--count':
        args.count = Number(argv[i + 1]);
        i += 1;
        break;
      case '--region':
        args.region = argv[i + 1];
        i += 1;
        break;
      case '--endpoint':
        args.endpoint = argv[i + 1];
        i += 1;
        break;
      case '--concurrency':
        args.concurrency = Number(argv[i + 1]);
        i += 1;
        break;
      case '--force-path-style':
        args.forcePathStyle = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) {
    return '';
  }
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.bucket) {
    console.error('Missing required --bucket');
    process.exit(1);
  }

  if (!Number.isFinite(args.count) || args.count <= 0) {
    console.error('Invalid --count value');
    process.exit(1);
  }

  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) {
    console.error('Invalid --concurrency value');
    process.exit(1);
  }

  const prefix = normalizePrefix(args.prefix);
  const width = String(args.count).length;

  const client = new S3Client({
    region: args.region,
    endpoint: args.endpoint,
    forcePathStyle: args.forcePathStyle || undefined,
  });

  let completed = 0;
  const total = args.count;

  const uploadOne = async (index: number) => {
    const key = `${prefix}item-${String(index + 1).padStart(width, '0')}.txt`;
    await client.send(
      new PutObjectCommand({
        Bucket: args.bucket,
        Key: key,
        Body: '',
        ContentType: 'text/plain',
      })
    );
    completed += 1;
    if (completed % 500 === 0 || completed === total) {
      console.log(`Uploaded ${completed}/${total}`);
    }
  };

  for (let i = 0; i < total; i += args.concurrency) {
    const batch: Array<Promise<void>> = [];
    const end = Math.min(total, i + args.concurrency);
    for (let j = i; j < end; j += 1) {
      batch.push(uploadOne(j));
    }
    await Promise.all(batch);
  }
}

main().catch((error) => {
  console.error('Failed to create test items:', error);
  process.exit(1);
});
