import { useState, useCallback, useEffect } from 'react';
import type { SavedConnection } from '../types';

const STORAGE_KEY = 's3browser_connections';
const MAX_CONNECTIONS = 10;

function loadConnections(): SavedConnection[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function persistConnections(connections: SavedConnection[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
}

export function useConnectionHistory() {
  const [connections, setConnections] = useState<SavedConnection[]>([]);

  useEffect(() => {
    setConnections(loadConnections());
  }, []);

  const saveConnection = useCallback((connection: Omit<SavedConnection, 'id' | 'lastUsedAt'> & { id?: string }) => {
    setConnections((prev) => {
      const existingIndex = connection.id
        ? prev.findIndex((c) => c.id === connection.id)
        : -1;

      const newConnection: SavedConnection = {
        ...connection,
        id: connection.id || crypto.randomUUID(),
        lastUsedAt: Date.now(),
      };

      let updated: SavedConnection[];
      if (existingIndex >= 0) {
        updated = [...prev];
        updated[existingIndex] = newConnection;
      } else {
        updated = [newConnection, ...prev];
      }

      // Sort by lastUsedAt descending and limit to MAX_CONNECTIONS
      updated.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      updated = updated.slice(0, MAX_CONNECTIONS);

      persistConnections(updated);
      return updated;
    });
  }, []);

  const deleteConnection = useCallback((id: string) => {
    setConnections((prev) => {
      const updated = prev.filter((c) => c.id !== id);
      persistConnections(updated);
      return updated;
    });
  }, []);

  const updateLastUsed = useCallback((id: string) => {
    setConnections((prev) => {
      const index = prev.findIndex((c) => c.id === id);
      if (index < 0) return prev;

      const updated = [...prev];
      updated[index] = { ...updated[index], lastUsedAt: Date.now() };
      updated.sort((a, b) => b.lastUsedAt - a.lastUsedAt);

      persistConnections(updated);
      return updated;
    });
  }, []);

  return {
    connections,
    saveConnection,
    deleteConnection,
    updateLastUsed,
  };
}
