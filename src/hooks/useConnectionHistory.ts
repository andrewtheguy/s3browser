import { useState, useCallback, useEffect, useRef } from 'react';
import type { SavedConnection } from '../types';
import {
  getConnections,
  deleteConnectionFromServer,
  type ServerSavedConnection,
} from '../services/api/auth';

function serverToSavedConnection(conn: ServerSavedConnection): SavedConnection & { id: number; secretAccessKey: string } {
  return {
    id: conn.id,
    name: conn.name,
    endpoint: conn.endpoint,
    accessKeyId: conn.accessKeyId,
    secretAccessKey: conn.secretAccessKey,
    bucket: conn.bucket || undefined,
    region: conn.region || undefined,
    autoDetectRegion: conn.autoDetectRegion,
    lastUsedAt: conn.lastUsedAt,
  };
}

export function useConnectionHistory(isUserLoggedIn: boolean) {
  const [connections, setConnections] = useState<(SavedConnection & { id: number; secretAccessKey: string })[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  // Shared fetch helper with cancellation via requestId
  const doFetch = useCallback(async () => {
    const currentRequestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const serverConnections = await getConnections();
      // Only update state if this is still the latest request
      if (currentRequestId === requestIdRef.current) {
        setConnections(serverConnections.map(serverToSavedConnection));
      }
    } catch (err) {
      if (currentRequestId === requestIdRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch connections');
        console.error('Failed to fetch connections:', err);
      }
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Fetch connections when user logs in
  useEffect(() => {
    if (!isUserLoggedIn) {
      setConnections([]);
      return;
    }

    void doFetch();
  }, [isUserLoggedIn, doFetch]);

  const deleteConnection = useCallback(async (connectionId: number) => {
    if (!isUserLoggedIn) {
      throw new Error('Cannot delete connection: user is not logged in');
    }

    try {
      await deleteConnectionFromServer(connectionId);

      // Update local state
      setConnections((prev) => prev.filter((c) => c.id !== connectionId));
    } catch (err) {
      console.error('Failed to delete connection:', err);
      throw err;
    }
  }, [isUserLoggedIn]);

  const refresh = useCallback(async () => {
    if (!isUserLoggedIn) return;

    await doFetch();
  }, [isUserLoggedIn, doFetch]);

  return {
    connections,
    isLoading,
    error,
    deleteConnection,
    refresh,
  };
}
