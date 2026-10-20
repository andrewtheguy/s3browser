/**
 * URL encoding utilities for S3 paths
 *
 * S3 keys can contain special characters (spaces, +, %, etc.) that need
 * proper encoding for URLs. We use encodeURIComponent for each path segment.
 */

/**
 * Encode an S3 path for use in a URL
 * Each segment is individually encoded to handle special characters
 */
export function encodeS3PathForUrl(path: string): string {
  if (!path) return '';

  // Split by /, encode each segment, rejoin
  const segments = path.split('/').filter(Boolean);
  return segments.map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Decode a URL path back to an S3 path
 * @param urlPath - The URL-encoded path to decode
 * @param addTrailingSlash - If true, append a trailing slash for folder-style paths (default: false)
 */
export function decodeUrlToS3Path(urlPath: string, addTrailingSlash: boolean = false): string {
  if (!urlPath) return '';

  // Split, decode each segment, rejoin
  const segments = urlPath.split('/').filter(Boolean);
  const decoded = segments.map(segment => decodeURIComponent(segment)).join('/');

  if (!decoded) return '';
  return addTrailingSlash ? decoded + '/' : decoded;
}

/**
 * Build a browse URL for a given connection, bucket and path
 */
export function buildBrowseUrl(connectionId: number, bucket: string, path: string): string {
  const encodedPath = encodeS3PathForUrl(path);
  if (encodedPath) {
    return `/connection/${connectionId}/browse/${encodeURIComponent(bucket)}/${encodedPath}/`;
  }
  return `/connection/${connectionId}/browse/${encodeURIComponent(bucket)}/`;
}

/**
 * Build a search URL for a given connection and bucket. When a non-empty
 * prefix is provided, the search is scoped to that prefix via ?prefix=...
 */
export function buildSearchUrl(connectionId: number, bucket: string, prefix: string = ''): string {
  const base = `/connection/${connectionId}/search/${encodeURIComponent(bucket)}`;
  if (!prefix) return base;
  return `${base}?prefix=${encodeURIComponent(prefix)}`;
}

/**
 * Build an inline preview URL for a given connection, bucket and object key.
 * No trailing slash — the /preview/ route segment distinguishes file URLs from folder browse URLs.
 */
export function buildPreviewUrl(connectionId: number, bucket: string, key: string): string {
  const encodedKey = encodeS3PathForUrl(key);
  return `/connection/${connectionId}/preview/${encodeURIComponent(bucket)}/${encodedKey}`;
}

/**
 * The bucket page of a connection: recent buckets, the full list, or a name typed by hand.
 */
export function buildSelectBucketUrl(connectionId: number): string {
  return `/connection/${connectionId}`;
}

export const CONNECTIONS_URL = '/';
export const CONNECTION_NEW_URL = '/connection/new';
export const LOGIN_URL = '/login';

export function buildConnectionEditUrl(connectionId: number): string {
  return `/connection/${connectionId}/edit`;
}

/**
 * The login page, remembering where to return to afterwards.
 */
export function buildLoginUrl(next?: string): string {
  if (!next || next === '/' || !isSafeReturnPath(next)) return LOGIN_URL;
  return `${LOGIN_URL}?next=${encodeURIComponent(next)}`;
}

/**
 * Only same-origin paths may be used as a post-login redirect; protocol-relative
 * `//host` and absolute URLs are rejected.
 */
export function isSafeReturnPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}

/**
 * Parse the `:connectionId` route param; null when missing or not a positive integer.
 */
export function parseConnectionId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number.parseInt(raw, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Normalize a path to ensure consistent trailing slash behavior
 * Folders should have trailing slashes, empty path should be ''
 */
export function normalizePath(path: string): string {
  if (!path) return '';

  // Remove leading/trailing slashes, then add trailing slash
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  return trimmed ? trimmed + '/' : '';
}
