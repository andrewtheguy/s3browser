import { S3Client } from '@aws-sdk/client-s3';
import type { S3Credentials } from '../../types';

export function createS3Client(credentials: S3Credentials): S3Client {
  return new S3Client({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
}
