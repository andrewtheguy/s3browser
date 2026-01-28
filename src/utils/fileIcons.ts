import { getFileExtension } from './formatters';

export type FileIconType =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'archive'
  | 'code'
  | 'text'
  | 'file';

const extensionMap: Record<string, FileIconType> = {
  // Images
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  tiff: 'image',
  tif: 'image',

  // Videos
  mp4: 'video',
  webm: 'video',
  avi: 'video',
  mov: 'video',
  mkv: 'video',
  wmv: 'video',
  flv: 'video',

  // Audio
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  flac: 'audio',
  aac: 'audio',
  m4a: 'audio',

  // Documents
  pdf: 'pdf',
  doc: 'document',
  docx: 'document',
  rtf: 'document',
  odt: 'document',

  // Spreadsheets
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  csv: 'spreadsheet',
  ods: 'spreadsheet',

  // Archives
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',

  // Code
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  html: 'code',
  css: 'code',
  scss: 'code',
  less: 'code',
  json: 'code',
  xml: 'code',
  yaml: 'code',
  yml: 'code',
  py: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  cs: 'code',
  go: 'code',
  rs: 'code',
  rb: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  sql: 'code',

  // Text
  txt: 'text',
  md: 'text',
  log: 'text',
};

export function getFileIconType(filename: string, isFolder: boolean): FileIconType {
  if (isFolder) return 'folder';

  const ext = getFileExtension(filename);
  return extensionMap[ext] || 'file';
}
