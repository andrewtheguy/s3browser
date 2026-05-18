import { indexS3Bucket, resetIndex } from '../indexing.js';
import { acquireLock, releaseLock, INDEX_LOCK_FILE } from '../lock.js';

export async function runIndex(opts: {
  connectionId: number;
  bucket?: string;
  batchSize: number;
}): Promise<void> {
  try {
    acquireLock(INDEX_LOCK_FILE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to acquire index lock');
    process.exit(1);
  }
  try {
    await indexS3Bucket({
      connectionId: opts.connectionId,
      bucket: opts.bucket,
      batchSize: opts.batchSize,
    });
  } finally {
    releaseLock(INDEX_LOCK_FILE);
  }
}

export function runIndexReset(): void {
  try {
    acquireLock(INDEX_LOCK_FILE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to acquire index lock');
    process.exit(1);
  }
  try {
    resetIndex();
  } finally {
    releaseLock(INDEX_LOCK_FILE);
  }
}
