export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket?: string;  // Optional - can be selected after login
  endpoint?: string;
}

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
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'paused';
  error?: string;
  // Multipart upload fields
  uploadId?: string;
  isMultipart?: boolean;
  completedParts?: number;
  totalParts?: number;
  canResume?: boolean;
  // Persistence ID for IndexedDB
  persistenceId?: string;
}

export interface UploadCandidate {
  file: File;
  key?: string;
  relativePath?: string;
}

export interface LoginCredentials {
  password: string;
}

export interface S3ConnectionCredentials extends Omit<S3Credentials, 'region'> {
  region?: string;
  connectionName: string;
  autoDetectRegion?: boolean;
  connectionId?: number;
}

export interface S3ClientContextValue {
  credentials: S3Credentials | null;
  isConnected: boolean;
  isLoggedIn: boolean;
  activeConnectionId: number | null;
  isCheckingSession: boolean;
  requiresBucketSelection: boolean;
  login: (credentials: LoginCredentials) => Promise<boolean>;
  connect: (credentials: S3ConnectionCredentials) => Promise<{ success: boolean; connectionId?: number }>;
  disconnect: () => void | Promise<void>;
  activateConnection: (connectionId: number, bucket?: string) => Promise<boolean>;
  selectBucket: (bucket: string) => boolean;
  error: string | null;
  serverError: string | null;
  retryConnection: () => void;
}

export interface BrowserContextValue {
  currentPath: string;
  objects: S3Object[];
  isLoading: boolean;
  error: string | null;
  navigateTo: (path: string) => void;
  navigateUp: () => void;
  refresh: () => Promise<void>;
  pathSegments: string[];
}

export interface SavedConnection {
  name: string;              // Used as unique key
  endpoint: string;
  accessKeyId: string;
  bucket?: string;           // Optional - can be selected after login
  region?: string;
  autoDetectRegion: boolean;
  lastUsedAt: number;
}

export const AWS_REGIONS = [
  { value: 'us-east-1', label: 'US East (N. Virginia)' },
  { value: 'us-east-2', label: 'US East (Ohio)' },
  { value: 'us-west-1', label: 'US West (N. California)' },
  { value: 'us-west-2', label: 'US West (Oregon)' },
  { value: 'eu-west-1', label: 'EU (Ireland)' },
  { value: 'eu-west-2', label: 'EU (London)' },
  { value: 'eu-west-3', label: 'EU (Paris)' },
  { value: 'eu-central-1', label: 'EU (Frankfurt)' },
  { value: 'eu-north-1', label: 'EU (Stockholm)' },
  { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  { value: 'ap-northeast-2', label: 'Asia Pacific (Seoul)' },
  { value: 'ap-northeast-3', label: 'Asia Pacific (Osaka)' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
  { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
  { value: 'ap-south-1', label: 'Asia Pacific (Mumbai)' },
  { value: 'sa-east-1', label: 'South America (São Paulo)' },
  { value: 'ca-central-1', label: 'Canada (Central)' },
] as const;
