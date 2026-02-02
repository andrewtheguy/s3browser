import { Router, Response } from 'express';
import {
  GetBucketVersioningCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { s3Middleware, requireBucket, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

interface LifecycleRule {
  id?: string;
  status: string;
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
    status: 'Enabled' | 'Suspended' | 'Disabled';
    mfaDelete?: 'Enabled' | 'Disabled';
  };
  encryption: {
    enabled: boolean;
    type?: string;
    kmsKeyId?: string;
  } | null;
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
    versioning: { status: 'Disabled' },
    encryption: null,
    lifecycleRules: [],
  };

  // Get versioning status
  try {
    const versioningCommand = new GetBucketVersioningCommand({ Bucket: bucket });
    const versioningResponse = await client.send(versioningCommand);
    result.versioning = {
      status: versioningResponse.Status ?? 'Disabled',
      mfaDelete: versioningResponse.MFADelete,
    };
  } catch (err) {
    // If we can't get versioning, leave as default
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
        let encryptionType: string | undefined = defaultRule.SSEAlgorithm;
        if (encryptionType === 'AES256') {
          encryptionType = 'SSE-S3 (AES-256)';
        } else if (encryptionType === 'aws:kms') {
          encryptionType = 'SSE-KMS';
        }
        result.encryption = {
          enabled: true,
          type: encryptionType,
          kmsKeyId: defaultRule.KMSMasterKeyID,
        };
      }
    }
  } catch (err: unknown) {
    // ServerSideEncryptionConfigurationNotFoundError means no encryption configured
    const errorName = (err as { name?: string })?.name;
    if (errorName !== 'ServerSideEncryptionConfigurationNotFoundError') {
      console.error('Failed to get bucket encryption:', err);
    }
    result.encryption = { enabled: false };
  }

  // Get lifecycle rules
  try {
    const lifecycleCommand = new GetBucketLifecycleConfigurationCommand({ Bucket: bucket });
    const lifecycleResponse = await client.send(lifecycleCommand);
    if (lifecycleResponse.Rules) {
      result.lifecycleRules = lifecycleResponse.Rules.map((rule) => ({
        id: rule.ID,
        status: rule.Status ?? 'Unknown',
        prefix: rule.Prefix ?? rule.Filter?.Prefix,
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
    // NoSuchLifecycleConfiguration means no lifecycle rules configured
    const errorName = (err as { name?: string })?.name;
    if (errorName !== 'NoSuchLifecycleConfiguration') {
      console.error('Failed to get bucket lifecycle:', err);
    }
  }

  res.json(result);
});

export default router;
