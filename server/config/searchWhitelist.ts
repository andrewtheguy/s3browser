import { normalizeEndpoint } from '../middleware/auth.js';

export const SEARCH_WHITELIST_ENV_VAR = 'S3BROWSER_SEARCH_WHITELIST_HOSTS';

let cachedHosts: ReadonlySet<string> | null = null;

function parseHosts(raw: string | undefined): Set<string> {
  const hosts = new Set<string>();
  if (!raw) return hosts;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed) hosts.add(trimmed);
  }
  return hosts;
}

export function getSearchWhitelistHosts(): ReadonlySet<string> {
  if (!cachedHosts) {
    cachedHosts = parseHosts(process.env[SEARCH_WHITELIST_ENV_VAR]);
  }
  return cachedHosts;
}

// Returns the parsed hostname for a connection's endpoint, or null if the
// connection has no endpoint set or the value can't be parsed as a URL.
// Connections without an explicit endpoint are never whitelisted; operators
// who want search on AWS must set the explicit AWS S3 endpoint URL on the
// connection rather than relying on an implicit default.
export function getEffectiveEndpointHost(endpoint: string | null | undefined): string | null {
  const trimmed = endpoint?.trim();
  if (!trimmed) return null;
  const normalized = normalizeEndpoint(trimmed);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isEndpointWhitelisted(endpoint: string | null | undefined): boolean {
  const hosts = getSearchWhitelistHosts();
  if (hosts.size === 0) return false;
  const host = getEffectiveEndpointHost(endpoint);
  if (!host) return false;
  return hosts.has(host);
}
