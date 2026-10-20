import { QueryClient } from '@tanstack/react-query';
import { ApiHttpError } from '../services/api/client';

function isClientError(error: unknown): boolean {
  return error instanceof ApiHttpError && error.status >= 400 && error.status < 500;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => failureCount < 1 && !isClientError(error),
      refetchOnWindowFocus: false,
    },
  },
});
