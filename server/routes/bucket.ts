import { Router, Response } from 'express';
import {
  GetBucketVersioningCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { s3Middleware, requireBucket, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

function isEncryptionNotSupported(error: unknown): boolean {
  const err = error as {
    name?: string;
    code?: string;
    Code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const httpStatus = err.$metadata?.httpStatusCode;
  if (httpStatus === 501) {
    return true;
  }
  const name = err.name ?? err.code ?? err.Code;
  if (name && ['NotImplemented', 'NotImplementedException', 'NotImplementedError', 'UnsupportedOperation'].includes(name)) {
    return true;
  }
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  return message.includes('not implemented') || message.includes('notimplemented') || message.includes('unimplemented');
}

function isLifecycleNotConfigured(error: unknown): boolean {
  const err = error as {
    name?: string;
    code?: string;
    Code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const httpStatus = err.$metadata?.httpStatusCode;
  if (httpStatus === 404) {
    return true;
  }
  const name = err.name ?? err.code ?? err.Code;
  if (name && ['NoSuchLifecycleConfiguration', 'NotFound'].includes(name)) {
    return true;
  }
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  return message.includes('nosuchlifecycleconfiguration') || message.includes('no such lifecycle configuration');
}

interface LifecycleRule {
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

interface BucketInfo {
  versioning: {
    status?: string;
    mfaDelete?: string;
  } | null;
  encryption: {
    algorithm?: string;
    kmsKeyId?: string;
  } | null;
  encryptionError?: string;
  lifecycleRules: LifecycleRule[];
}

// GET /api/bucket/:connectionId/:bucket/info
router.get('/:connectionId/:bucket/info', s3Middleware, requireBucket, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const bucket = req.s3Credentials?.bucket;
  const client = req.s3Client;

  if (!bucket || !client) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const result: BucketInfo = {
    versioning: null,
    encryption: null,
    lifecycleRules: [],
  };

  // Get versioning status
  try {
    const versioningCommand = new GetBucketVersioningCommand({ Bucket: bucket });
    const versioningResponse = await client.send(versioningCommand);
    result.versioning = {
      status: versioningResponse.Status,
      mfaDelete: versioningResponse.MFADelete,
    };
  } catch (err) {
    // If we can't get versioning, leave as null
    console.error('Failed to get bucket versioning:', err);
  }

  // Get encryption settings
  try {
    const encryptionCommand = new GetBucketEncryptionCommand({ Bucket: bucket });
    const encryptionResponse = await client.send(encryptionCommand);
    const rules = encryptionResponse.ServerSideEncryptionConfiguration?.Rules;
    if (rules && rules.length > 0) {
      const defaultRule = rules[0].ApplyServerSideEncryptionByDefault;
      if (defaultRule) {
        result.encryption = {
          algorithm: defaultRule.SSEAlgorithm,
          kmsKeyId: defaultRule.KMSMasterKeyID,
        };
      }
    }
  } catch (err: unknown) {
    const errorName = (err as { name?: string })?.name;
    if (errorName === 'ServerSideEncryptionConfigurationNotFoundError') {
      // No encryption configured - leave as null
    } else if (isEncryptionNotSupported(err)) {
      result.encryptionError = 'Not supported by this storage provider';
    } else {
      // Real error - store for display
      console.error('Failed to get bucket encryption:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.encryptionError = errorName ? `${errorName}: ${errorMessage}` : errorMessage;
    }
  }

  // Get lifecycle rules
  try {
    const lifecycleCommand = new GetBucketLifecycleConfigurationCommand({ Bucket: bucket });
    const lifecycleResponse = await client.send(lifecycleCommand);
    if (lifecycleResponse.Rules) {
      result.lifecycleRules = lifecycleResponse.Rules.map((rule) => ({
        id: rule.ID,
        status: rule.Status ?? 'Unknown',
        prefix: rule.Filter?.Prefix,
        expiration: rule.Expiration ? {
          days: rule.Expiration.Days,
          date: rule.Expiration.Date?.toISOString(),
          expiredObjectDeleteMarker: rule.Expiration.ExpiredObjectDeleteMarker,
        } : undefined,
        transitions: rule.Transitions?.map((t) => ({
          days: t.Days,
          date: t.Date?.toISOString(),
          storageClass: t.StorageClass ?? 'Unknown',
        })),
        noncurrentVersionExpiration: rule.NoncurrentVersionExpiration ? {
          days: rule.NoncurrentVersionExpiration.NoncurrentDays,
          newerNoncurrentVersions: rule.NoncurrentVersionExpiration.NewerNoncurrentVersions,
        } : undefined,
        abortIncompleteMultipartUpload: rule.AbortIncompleteMultipartUpload ? {
          daysAfterInitiation: rule.AbortIncompleteMultipartUpload.DaysAfterInitiation,
        } : undefined,
      }));
    }
  } catch (err: unknown) {
    // Treat "not configured" as empty lifecycle rules (no log).
    if (!isLifecycleNotConfigured(err)) {
      console.error('Failed to get bucket lifecycle:', err);
    }
  }

  res.json(result);
});

export default router;
