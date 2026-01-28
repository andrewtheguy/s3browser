#!/usr/bin/env bun
/**
 * Build script that compiles a standalone macOS executable with embedded frontend assets.
 * Uses Bun's `with { type: 'text' }` imports for automatic asset embedding at compile time.
 */

import { execSync } from 'child_process';
import { statSync } from 'fs';
import { join } from 'path';

const projectRoot = join(import.meta.dir, '..');
const standaloneEntry = join(projectRoot, 'server', 'standalone.ts');
const outputPath = join(projectRoot, 's3browser');

async function build() {
  console.log('Building standalone S3 Browser...\n');

  // Step 1: Build the frontend with predictable asset names
  console.log('Step 1: Building frontend...');
  execSync('bun run build:client', { cwd: projectRoot, stdio: 'inherit' });

  // Step 2: Compile standalone server with embedded assets
  console.log('\nStep 2: Compiling standalone executable...');
  execSync(`bun build ${standaloneEntry} --compile --outfile ${outputPath} --target bun`, {
    cwd: projectRoot,
    stdio: 'inherit',
  });

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
