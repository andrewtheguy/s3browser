export const UPLOAD_CONFIG = {
  /** Size of each part in multipart upload (10MB) */
  PART_SIZE: 10 * 1024 * 1024,
  /** Files >= this size use multipart upload (10MB) */
  MULTIPART_THRESHOLD: 10 * 1024 * 1024,
  /** Maximum file size (5GB) */
  MAX_FILE_SIZE: 5 * 1024 * 1024 * 1024,
} as const;
