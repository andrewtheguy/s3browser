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
 * Build a search URL for a given connection and bucket. Search is always
 * bucket-wide; folder scoping is intentionally not supported.
 */
export function buildSearchUrl(connectionId: number, bucket: string): string {
  return `/connection/${connectionId}/search/${encodeURIComponent(bucket)}`;
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
 * Build a select-bucket URL for a given connection
 */
export function buildSelectBucketUrl(connectionId: number): string {
  return `/connection/${connectionId}/browse`;
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
