#!/usr/bin/env bun
/**
 * Build script that compiles a standalone executable with embedded frontend assets.
 * Uses Bun's `with { type: 'text' }` imports for automatic asset embedding at compile time.
 * Builds for the current platform by default (macOS, Linux, or Windows).
 */

import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

const projectRoot = join(import.meta.dir, '..');
const standaloneEntry = join(projectRoot, 'server', 'standalone.ts');
const outputPath = join(projectRoot, 's3browser');

async function build() {
  console.log('Building standalone S3 Browser...\n');

  // Step 1: Build the frontend with deterministic asset names (no hashes)
  console.log('Step 1: Building frontend...');
  try {
    execSync('bun run build:client', {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, STANDALONE_BUILD: 'true' },
    });
  } catch {
    console.error('Error: Frontend build failed');
    process.exit(1);
  }

  // Step 2: Compile standalone server for current platform with embedded assets
  console.log('\nStep 2: Compiling standalone executable...');
  try {
    execSync(`bun build ${standaloneEntry} --compile --outfile ${outputPath} --target bun`, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
  } catch {
    console.error('Error: Standalone compilation failed');
    process.exit(1);
  }

  // Verify output exists
  if (!existsSync(outputPath)) {
    console.error(`Error: Expected output file not found: ${outputPath}`);
    process.exit(1);
  }

  // Report success
  const stat = statSync(outputPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ Build complete: ${outputPath} (${sizeMB} MB)`);
  console.log('  Run with: ./s3browser');
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
