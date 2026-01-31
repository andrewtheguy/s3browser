import { useState, useCallback, useEffect } from 'react';
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

  // Fetch connections when user logs in
  useEffect(() => {
    if (!isUserLoggedIn) {
      setConnections([]);
      return;
    }

    let cancelled = false;

    async function fetchConnections() {
      setIsLoading(true);
      setError(null);
      try {
        const serverConnections = await getConnections();
        if (!cancelled) {
          setConnections(serverConnections.map(serverToSavedConnection));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch connections');
          console.error('Failed to fetch connections:', err);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void fetchConnections();

    return () => {
      cancelled = true;
    };
  }, [isUserLoggedIn]);

  const deleteConnection = useCallback(async (connectionId: number) => {
    try {
      await deleteConnectionFromServer(connectionId);

      // Update local state
      setConnections((prev) => prev.filter((c) => c.id !== connectionId));
    } catch (err) {
      console.error('Failed to delete connection:', err);
      throw err;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!isUserLoggedIn) return;

    setIsLoading(true);
    setError(null);
    try {
      const serverConnections = await getConnections();
      setConnections(serverConnections.map(serverToSavedConnection));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch connections');
      console.error('Failed to fetch connections:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isUserLoggedIn]);

  return {
    connections,
    isLoading,
    error,
    deleteConnection,
    refresh,
  };
}
