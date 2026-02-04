import { apiGet } from './client';

export interface LifecycleRule {
  id?: string;
  status: 'Enabled' | 'Disabled' | 'Unknown';
  prefix?: string;
  expiration?: {
    days?: number;
    date?: string;
    expiredObjectDeleteMarker?: boolean;
  };
  transitions?: Array<{
    days?: number;
    date?: string;
    storageClass: string;
  }>;
  noncurrentVersionExpiration?: {
    days?: number;
    newerNoncurrentVersions?: number;
  };
  abortIncompleteMultipartUpload?: {
    daysAfterInitiation?: number;
  };
}

export interface BucketInfo {
  versioning: {
    status?: string;
    mfaDelete?: string;
  } | null;
  encryption: {
    algorithm?: string;
    kmsKeyId?: string;
  } | null;
  encryptionError: string | null;
  lifecycleError: string | null;
  lifecycleRules: LifecycleRule[];
}

export async function getBucketInfo(
  connectionId: number,
  bucket: string,
  signal?: AbortSignal
): Promise<BucketInfo> {
  const response = await apiGet<BucketInfo>(
    `/bucket/${connectionId}/${encodeURIComponent(bucket)}/info`,
    signal
  );

  if (!response) {
    throw new Error('Failed to get bucket info: missing response');
  }

  return response;
}
