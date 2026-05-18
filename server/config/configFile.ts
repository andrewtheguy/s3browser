import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';

const CONFIG_PATH = join(homedir(), '.s3browser', 'config.toml');

const ALLOWED_KEYS = new Set([
  'S3BROWSER_LOGIN_PASSWORD',
  'S3BROWSER_PRESIGNED_URL_TTLS',
  'S3BROWSER_SEARCH_WHITELIST_HOSTS',
]);

function loadConfigFile(): void {
  if (!existsSync(CONFIG_PATH)) return;

  const content = readFileSync(CONFIG_PATH, 'utf8');

  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!ALLOWED_KEYS.has(key)) {
      console.warn(`config.toml: ignoring unknown key "${key}"`);
      continue;
    }
    if (key in process.env) continue;
    if (typeof value !== 'string') {
      throw new Error(`config.toml: key "${key}" must be a string`);
    }
    process.env[key] = value;
  }
}

loadConfigFile();
