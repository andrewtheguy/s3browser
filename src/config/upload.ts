export const UPLOAD_CONFIG = {
  /** Size of each part in multipart upload (10MB) */
  PART_SIZE: 10 * 1024 * 1024,
  /** Files >= this size use multipart upload (10MB) */
  MULTIPART_THRESHOLD: 10 * 1024 * 1024,
  /** Number of parallel file uploads */
  FILE_CONCURRENCY: 5,
  /** Number of parallel part uploads */
  CONCURRENCY: 3,
  /** Presigned URL expiry in seconds (15 minutes) */
  PRESIGN_EXPIRY: 15 * 60,
  /** Maximum file size (5GB - S3 multipart limit per part is 5GB, total 5TB) */
  MAX_FILE_SIZE: 5 * 1024 * 1024 * 1024,
  /** Number of retry attempts for failed part uploads */
  MAX_RETRIES: 3,
} as const;
