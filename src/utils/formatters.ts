export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes < 0) return '-';
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    units.length - 1
  );
  const size = bytes / Math.pow(k, i);

  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(date?: Date): string {
  if (!date) return '-';

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot + 1).toLowerCase();
}

export function extractFileName(key: string): string {
  // Remove trailing slash for folders
  const cleanKey = key.endsWith('/') ? key.slice(0, -1) : key;
  const parts = cleanKey.split('/');
  return parts[parts.length - 1] || cleanKey;
}

export function getParentPath(path: string): string {
  if (!path || path === '/') return '';
  const cleanPath = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSlash = cleanPath.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return cleanPath.slice(0, lastSlash + 1);
}

export function normalizePath(path: string): string {
  if (!path) return '';
  // Remove leading slash if present
  let normalized = path.startsWith('/') ? path.slice(1) : path;
  // Ensure trailing slash for non-empty paths
  if (normalized && !normalized.endsWith('/')) {
    normalized += '/';
  }
  return normalized;
}

export function getPathSegments(path: string): string[] {
  if (!path) return [];
  return path.split('/').filter(Boolean);
}

/**
 * Sort S3 objects: folders first, then files, alphabetically by name.
 * Should be called client-side after aggregating all pages when using pagination.
 */
export function sortObjects<T extends { isFolder: boolean; name: string }>(objects: T[]): T[] {
  return [...objects].sort((a, b) => {
    if (a.isFolder && !b.isFolder) return -1;
    if (!a.isFolder && b.isFolder) return 1;
    return a.name.localeCompare(b.name);
  });
}
