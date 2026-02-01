import { getFileExtension } from './formatters';

export const PREVIEWABLE_EXTENSIONS = new Set([
  // Code files
  'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'scss', 'less', 'json', 'xml',
  'yaml', 'yml', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs',
  'rb', 'php', 'sh', 'bash', 'sql', 'vue', 'svelte',
  // Text/config files
  'txt', 'md', 'log', 'csv', 'toml', 'ini', 'env',
]);

export const PREVIEWABLE_FILENAMES = new Set([
  'Makefile', 'Dockerfile', 'LICENSE', 'README', 'CHANGELOG',
  '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc',
  '.eslintrc', '.babelrc', '.env', '.env.local', '.env.example',
]);

export const MAX_PREVIEW_SIZE = 262144; // 256KB

export interface PreviewabilityResult {
  canPreview: boolean;
  reason?: string;
}

export function isPreviewableFile(filename: string, size?: number): PreviewabilityResult {
  const ext = getFileExtension(filename);
  const basename = filename.split('/').pop() || filename;

  const isPreviewableType = PREVIEWABLE_EXTENSIONS.has(ext) || PREVIEWABLE_FILENAMES.has(basename);

  if (!isPreviewableType) {
    return { canPreview: false, reason: 'File type not supported for preview' };
  }

  if (size === undefined) {
    return { canPreview: false, reason: 'File size unknown' };
  }

  if (size > MAX_PREVIEW_SIZE) {
    return { canPreview: false, reason: 'File is too large to preview (max 256KB)' };
  }

  return { canPreview: true };
}
