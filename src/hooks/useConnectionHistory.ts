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
    // Only load connections with valid name (no spaces, non-empty)
    return parsed.filter(
      (c): c is SavedConnection =>
        typeof c.name === 'string' && c.name.length > 0 && !c.name.includes(' ')
    );
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

  const saveConnection = useCallback((connection: Omit<SavedConnection, 'lastUsedAt'>) => {
    if (!connection.name || connection.name.includes(' ')) {
      return; // Don't save if name is empty or has spaces
    }

    setConnections((prev) => {
      const existingIndex = prev.findIndex((c) => c.name === connection.name);

      const newConnection: SavedConnection = {
        ...connection,
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

  const deleteConnection = useCallback((name: string) => {
    setConnections((prev) => {
      const updated = prev.filter((c) => c.name !== name);
      persistConnections(updated);
      return updated;
    });
  }, []);

  return {
    connections,
    saveConnection,
    deleteConnection,
  };
}
