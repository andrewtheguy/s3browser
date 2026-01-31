import { useState, useCallback, useEffect } from 'react';
import type { SavedConnection } from '../types';
import {
  getConnections,
  saveConnectionToServer,
  deleteConnectionFromServer,
  type ServerSavedConnection,
} from '../services/api/auth';

function serverToSavedConnection(conn: ServerSavedConnection): SavedConnection & { secretAccessKey: string } {
  return {
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
  const [connections, setConnections] = useState<(SavedConnection & { secretAccessKey: string })[]>([]);
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

  const saveConnection = useCallback(async (connection: Omit<SavedConnection, 'lastUsedAt'> & { secretAccessKey: string }) => {
    try {
      await saveConnectionToServer({
        name: connection.name,
        endpoint: connection.endpoint,
        accessKeyId: connection.accessKeyId,
        secretAccessKey: connection.secretAccessKey,
        bucket: connection.bucket,
        region: connection.region,
        autoDetectRegion: connection.autoDetectRegion,
      });

      // Update local state
      setConnections((prev) => {
        const existingIndex = prev.findIndex((c) => c.name === connection.name);
        const newConnection: SavedConnection & { secretAccessKey: string } = {
          ...connection,
          lastUsedAt: Date.now(),
        };

        let updated: (SavedConnection & { secretAccessKey: string })[];
        if (existingIndex >= 0) {
          updated = [...prev];
          updated[existingIndex] = newConnection;
        } else {
          updated = [newConnection, ...prev];
        }

        // Sort by lastUsedAt descending
        updated.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        return updated;
      });
    } catch (err) {
      console.error('Failed to save connection:', err);
      throw err;
    }
  }, []);

  const deleteConnection = useCallback(async (name: string) => {
    try {
      await deleteConnectionFromServer(name);

      // Update local state
      setConnections((prev) => prev.filter((c) => c.name !== name));
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
    saveConnection,
    deleteConnection,
    refresh,
  };
}
