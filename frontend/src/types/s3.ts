export interface BucketInfo {
  name: string;
  creationDate?: string;
}

export interface S3Object {
  key: string;
  name: string;
  size?: number;
  lastModified?: Date;
  isFolder: boolean;
  etag?: string;
  versionId?: string;
  isLatest?: boolean;
  isDeleteMarker?: boolean;
  contentSnippet?: string | null;
  contentMatchCount?: number;
}

export interface S3ListResult {
  objects: S3Object[];
  continuationToken?: string;
  isTruncated: boolean;
}

export interface UploadProgress {
  id: string;
  file: File | null;
  fileName: string;
  fileLastModified: number;
  key: string;
  relativePath?: string;
  loaded: number;
  total: number;
  percentage: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
  // Multipart upload fields
  uploadId?: string;
  isMultipart?: boolean;
  completedParts?: number;
  totalParts?: number;
  canResume?: boolean;
  // Persistence ID for in-memory resume tracking
  persistenceId?: string;
}

export interface UploadCandidate {
  file: File;
  key?: string;
  relativePath?: string;
}

export interface BrowserContextValue {
  currentPath: string;
  objects: S3Object[];
  isLoading: boolean;
  error: string | null;
  isLimited: boolean;
  limitMessage: string | null;
  windowStart: number;
  hasNextWindow: boolean;
  loadNextWindow: () => Promise<void>;
  hasPrevWindow: boolean;
  loadPrevWindow: () => Promise<void>;
  navigateTo: (path: string) => void;
  navigateUp: () => void;
  refresh: () => Promise<void>;
  pathSegments: string[];
  showVersions: boolean;
  toggleShowVersions: () => void;
  /** null = still checking, true = supported, false = not supported/disabled */
  versioningSupported: boolean | null;
  /** Bucket versioning status when available */
  bucketVersioningStatus: 'enabled' | 'suspended' | 'disabled' | null;
}
