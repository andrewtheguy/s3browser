import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

export interface DeleteObjectParams {
  client: S3Client;
  bucket: string;
  key: string;
}

export async function deleteObject({
  client,
  bucket,
  key,
}: DeleteObjectParams): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  await client.send(command);
}
