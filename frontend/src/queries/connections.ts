import { useMutation, useQuery } from '@tanstack/react-query';
import {
  deleteConnectionFromServer,
  getConnection,
  getConnections,
  saveConnection,
  testConnection,
  type S3ConnectionCredentials,
  type ServerSavedConnection,
} from '../services/api/auth';
import { queryClient } from './client';
import { queryKeys } from './keys';

/** Saved connections in the server's order: most recently used first. */
export function useConnectionsQuery() {
  return useQuery({
    queryKey: queryKeys.connections,
    queryFn: getConnections,
    staleTime: 0,
  });
}

/**
 * One saved connection. Seeded from the list cache so opening a connection
 * renders immediately; still refetched in the background so recent buckets stay fresh.
 */
export function useConnectionQuery(connectionId: number | null) {
  return useQuery({
    queryKey: queryKeys.connection(connectionId ?? 0),
    queryFn: () => getConnection(connectionId ?? 0),
    enabled: connectionId !== null,
    staleTime: 0,
    initialData: () =>
      connectionId === null
        ? undefined
        : queryClient.getQueryData<ServerSavedConnection[]>(queryKeys.connections)?.find((c) => c.id === connectionId),
    initialDataUpdatedAt: () => queryClient.getQueryState(queryKeys.connections)?.dataUpdatedAt,
  });
}

export function useSaveConnectionMutation() {
  return useMutation({
    mutationFn: (credentials: S3ConnectionCredentials) => saveConnection(credentials),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections });
    },
  });
}

export function useDeleteConnectionMutation() {
  return useMutation({
    mutationFn: (connectionId: number) => deleteConnectionFromServer(connectionId),
    onSuccess: (_, connectionId) => {
      queryClient.removeQueries({ queryKey: queryKeys.connection(connectionId) });
      queryClient.removeQueries({ queryKey: queryKeys.buckets(connectionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections });
    },
  });
}

export function useTestConnectionMutation() {
  return useMutation({
    mutationFn: (credentials: S3ConnectionCredentials) => testConnection(credentials),
  });
}
