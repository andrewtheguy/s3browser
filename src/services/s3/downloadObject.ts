import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface DownloadObjectParams {
  client: S3Client;
  bucket: string;
  key: string;
  expiresIn?: number;
}

export async function getDownloadUrl({
  client,
  bucket,
  key,
  expiresIn = 3600,
}: DownloadObjectParams): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn });
}

export async function downloadObject(params: DownloadObjectParams): Promise<void> {
  const url = await getDownloadUrl(params);

  // Extract filename from key
  const filename = params.key.split('/').pop() || 'download';

  // Create a temporary link and trigger download
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
