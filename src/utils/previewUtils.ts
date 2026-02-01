import { getFileExtension } from './formatters';

export type EmbedType = 'text' | 'pdf' | 'image' | 'unsupported';

export const TEXT_EXTENSIONS = new Set([
  // Code files
  'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'scss', 'less', 'json', 'xml',
  'yaml', 'yml', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs',
  'rb', 'php', 'sh', 'bash', 'sql', 'vue', 'svelte',
  // Text/config files
  'txt', 'md', 'log', 'csv', 'toml', 'ini', 'env',
]);

export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico',
]);

export const PDF_EXTENSIONS = new Set(['pdf']);

export const PREVIEWABLE_FILENAMES = new Set([
  'Makefile', 'Dockerfile', 'LICENSE', 'README', 'CHANGELOG',
  '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc',
  '.eslintrc', '.babelrc', '.env', '.env.local', '.env.example',
]);

export function getEmbedType(filename: string): EmbedType {
  const ext = getFileExtension(filename);
  const basename = filename.split('/').pop() || filename;

  if (PDF_EXTENSIONS.has(ext)) {
    return 'pdf';
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }

  if (TEXT_EXTENSIONS.has(ext) || PREVIEWABLE_FILENAMES.has(basename)) {
    return 'text';
  }

  return 'unsupported';
}

export interface PreviewabilityResult {
  canPreview: boolean;
  embedType: EmbedType;
  reason?: string;
}

export function isPreviewableFile(filename: string): PreviewabilityResult {
  const embedType = getEmbedType(filename);

  if (embedType === 'unsupported') {
    return { canPreview: false, embedType, reason: 'File type not supported for preview' };
  }

  return { canPreview: true, embedType };
}
