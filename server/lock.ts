import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { FileSink } from 'bun';

const LOCK_DIR = join(homedir(), '.s3browser');
const LOCK_FILE = join(LOCK_DIR, 's3browser.lock');

let lockWriter: FileSink | null = null;

export async function acquireLock(): Promise<void> {
  // Ensure directory exists
  if (!existsSync(LOCK_DIR)) {
    mkdirSync(LOCK_DIR, { recursive: true });
  }

  try {
    // Open with exclusive lock - blocks/fails if another process holds the lock
    lockWriter = Bun.file(LOCK_FILE).writer({ lock: "exclusive" });
    // Write PID for informational purposes
    await lockWriter.write(String(process.pid));
    await lockWriter.flush();
    // Keep writer open to maintain lock
  } catch {
    throw new Error('Another s3browser instance is already running');
  }
}

export async function releaseLock(): Promise<void> {
  if (lockWriter) {
    await lockWriter.end();
    lockWriter = null;
  }
}
