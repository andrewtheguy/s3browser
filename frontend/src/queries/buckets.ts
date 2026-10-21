import { useMutation, useQuery } from '@tanstack/react-query';
import { listBuckets, validateBucket } from '../services/api/auth';
import { queryClient } from './client';
import { queryKeys } from './keys';

const BUCKETS_STALE_TIME = 5 * 60_000;

/** ListBuckets is a billed S3 call, so the result is kept for a while. */
export function useBucketsQuery(connectionId: number) {
  return useQuery({
    queryKey: queryKeys.buckets(connectionId),
    queryFn: () => listBuckets(connectionId),
    staleTime: BUCKETS_STALE_TIME,
  });
}

/** The explicit Refresh action: bypasses the cache and the server's region cache. */
export function refreshBuckets(connectionId: number) {
  return queryClient.fetchQuery({
    queryKey: queryKeys.buckets(connectionId),
    queryFn: () => listBuckets(connectionId, { clearRegionCache: true }),
    staleTime: 0,
  });
}

export function useValidateBucketMutation(connectionId: number) {
  return useMutation({
    mutationFn: (bucket: string) => validateBucket(connectionId, bucket),
  });
}
