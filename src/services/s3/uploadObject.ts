import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export interface UploadObjectParams {
  client: S3Client;
  bucket: string;
  key: string;
  file: File;
  onProgress?: (loaded: number, total: number) => void;
  abortController?: AbortController;
}

export async function uploadObject({
  client,
  bucket,
  key,
  file,
  onProgress,
  abortController,
}: UploadObjectParams): Promise<void> {
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: file,
      ContentType: file.type || 'application/octet-stream',
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024, // 5MB
    leavePartsOnError: false,
    abortController,
  });

  upload.on('httpUploadProgress', (progress) => {
    if (onProgress && progress.loaded !== undefined && progress.total !== undefined) {
      onProgress(progress.loaded, progress.total);
    }
  });

  await upload.done();
}

export interface CreateFolderParams {
  client: S3Client;
  bucket: string;
  folderPath: string;
}

export async function createFolder({
  client,
  bucket,
  folderPath,
}: CreateFolderParams): Promise<void> {
  // Ensure the folder path ends with /
  const normalizedPath = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: normalizedPath,
      Body: '',
      ContentType: 'application/x-directory',
    },
  });

  await upload.done();
}
