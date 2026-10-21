import { useParams } from 'react-router';
import { parseConnectionId } from '../utils/urlEncoding';

/**
 * The connection and bucket named in the URL. Only valid under
 * `/connection/:connectionId/(browse|preview|search)/:bucket` routes, which is
 * where every object operation lives.
 */
export function useBucketRoute(): { connectionId: number; bucket: string } {
  const { connectionId: rawConnectionId, bucket } = useParams<{ connectionId: string; bucket: string }>();
  const connectionId = parseConnectionId(rawConnectionId);
  if (connectionId === null || !bucket) {
    throw new Error('useBucketRoute must be used under a bucket route');
  }
  return { connectionId, bucket };
}
