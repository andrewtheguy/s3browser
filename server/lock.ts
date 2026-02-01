import { dlopen, FFIType } from 'bun:ffi';
import { openSync, closeSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOCK_DIR = join(homedir(), '.s3browser');
const LOCK_FILE = join(LOCK_DIR, 's3browser.lock');

// flock constants
const LOCK_EX = 2;  // Exclusive lock
const LOCK_NB = 4;  // Non-blocking

const flockSymbol = {
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
} as const;

// Library paths to try for different platforms
const libcPaths = process.platform === 'darwin'
  ? ['libSystem.B.dylib']
  : [
      'libc.so.6',         // glibc (most Linux distros)
      'libc.so',           // musl fallback
      'libc.musl-x86_64.so.1',  // Alpine x86_64
      'libc.musl-aarch64.so.1', // Alpine ARM64
      'libc.so.7',         // FreeBSD
    ];

function loadLibc() {
  for (const path of libcPaths) {
    try {
      return dlopen(path, flockSymbol);
    } catch {
      // Try next path
    }
  }
  throw new Error(`Failed to load libc. Tried: ${libcPaths.join(', ')}`);
}

const libc = loadLibc();

let lockFd: number | null = null;

export function acquireLock(): void {
  // Already holding the lock
  if (lockFd !== null) {
    return;
  }

  if (!existsSync(LOCK_DIR)) {
    mkdirSync(LOCK_DIR, { recursive: true });
  }

  // Open lock file (create if doesn't exist)
  const fd = openSync(LOCK_FILE, 'a');

  // Try to acquire exclusive non-blocking lock
  const result = libc.symbols.flock(fd, LOCK_EX | LOCK_NB);
  if (result !== 0) {
    closeSync(fd);
    throw new Error('Another s3browser instance is already running');
  }

  // Only set lockFd after successful lock acquisition
  lockFd = fd;
}

export function releaseLock(): void {
  if (lockFd !== null) {
    closeSync(lockFd);
    lockFd = null;
  }
}
