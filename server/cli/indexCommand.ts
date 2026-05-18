import { indexS3Bucket, resetIndex } from '../indexing.js';

export async function runIndex(opts: {
  connectionId: number;
  bucket?: string;
  batchSize: number;
}): Promise<void> {
  await indexS3Bucket({
    connectionId: opts.connectionId,
    bucket: opts.bucket,
    batchSize: opts.batchSize,
  });
}

export function runIndexReset(): void {
  resetIndex();
}
