import { useS3ClientContext } from '../contexts';

export function useS3Client() {
  return useS3ClientContext();
}
