import { dlopen, FFIType } from 'bun:ffi';
import { openSync, closeSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOCK_DIR = join(homedir(), '.s3browser');
const LOCK_FILE = join(LOCK_DIR, 's3browser.lock');

// flock constants
const LOCK_EX = 2;  // Exclusive lock
const LOCK_NB = 4;  // Non-blocking

// Load flock from libc
const libc = dlopen(
  process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6',
  {
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  }
);

let lockFd: number | null = null;

export function acquireLock(): void {
  if (!existsSync(LOCK_DIR)) {
    mkdirSync(LOCK_DIR, { recursive: true });
  }

  // Open lock file (create if doesn't exist)
  lockFd = openSync(LOCK_FILE, 'w');

  // Try to acquire exclusive non-blocking lock
  const result = libc.symbols.flock(lockFd, LOCK_EX | LOCK_NB);
  if (result !== 0) {
    closeSync(lockFd);
    lockFd = null;
    throw new Error('Another s3browser instance is already running');
  }
}

export function releaseLock(): void {
  if (lockFd !== null) {
    closeSync(lockFd);
    lockFd = null;
  }
}
