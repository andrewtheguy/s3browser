import { getFileExtension } from './formatters';

export type EmbedType = 'text' | 'pdf' | 'image' | 'video' | 'audio' | 'unsupported';

export const TEXT_EXTENSIONS = new Set([
  // Code files
  'js', 'ts', 'tsx', 'jsx', 'html', 'htm', 'css', 'scss', 'less', 'json', 'xml',
  'yaml', 'yml', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs',
  'rb', 'php', 'sh', 'bash', 'sql', 'vue', 'svelte',
  // Text/config files
  'txt', 'md', 'log', 'csv', 'toml', 'ini', 'env',
  // Additional text/config extensions
  'rst', 'tex', 'rtf', 'diff', 'patch', 'conf', 'cfg', 'properties',
  'gradle', 'kt', 'kts', 'scala', 'clj', 'ex', 'exs', 'erl', 'hrl',
  'hs', 'elm', 'ml', 'mli', 'r', 'jl', 'lua', 'pl', 'pm', 'swift',
  'dockerfile', 'makefile', 'cmake', 'tf', 'tfvars', 'nix',
]);

export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico',
]);

export const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov']);

// Note: .ogg is treated as audio (Ogg Vorbis); use .ogv for Ogg video
export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus',
]);

export const PDF_EXTENSIONS = new Set(['pdf']);

// MIME type mapping for overriding S3 Content-Type
const MIME_TYPES: Record<string, string> = {
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  // PDF
  pdf: 'application/pdf',
  // Text types
  txt: 'text/plain;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  // Force CSV previews to render inline as plain text to avoid browser download behavior.
  csv: 'text/plain;charset=utf-8',
  json: 'application/json',
  // Force XML previews to render as plain text to avoid inline rendering in the preview dialog.
  xml: 'text/plain;charset=utf-8',
  // Force HTML previews to render as plain text to avoid executing markup in the preview dialog.
  html: 'text/plain;charset=utf-8',
  htm: 'text/plain;charset=utf-8',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'application/typescript',
};

export function getMimeType(filename: string): string | undefined {
  const ext = getFileExtension(filename);
  return MIME_TYPES[ext];
}

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

  if (VIDEO_EXTENSIONS.has(ext)) {
    return 'video';
  }

  if (AUDIO_EXTENSIONS.has(ext)) {
    return 'audio';
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
