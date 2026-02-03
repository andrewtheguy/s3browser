import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_COUNT = 5000;
const DEFAULT_SUBFOLDER = 'tmp/generated-files';

function parseArgs() {
  const countArg = process.argv[2];
  const subfolderArg = process.argv[3];
  const count = countArg ? Number.parseInt(countArg, 10) : DEFAULT_COUNT;
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error('Count must be a positive integer');
  }
  const subfolder = subfolderArg?.trim() || DEFAULT_SUBFOLDER;
  return { count, subfolder };
}

async function main() {
  const { count, subfolder } = parseArgs();
  const targetDir = join(process.cwd(), subfolder);

  await mkdir(targetDir, { recursive: true });

  const writes: Array<Promise<void>> = [];
  for (let i = 1; i <= count; i += 1) {
    const filename = `file-${String(i).padStart(5, '0')}.txt`;
    const filepath = join(targetDir, filename);
    const content = `file ${i}\n`;
    writes.push(writeFile(filepath, content, 'utf8'));
  }

  await Promise.all(writes);
  console.log(`Created ${count} files in ${targetDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
