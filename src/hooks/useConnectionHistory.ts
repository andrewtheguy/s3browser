import { useState, useCallback } from 'react';
import type { SavedConnection } from '../types';

const STORAGE_KEY = 's3browser_connections';
const MAX_CONNECTIONS = 10;

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidSavedConnection(c: unknown): c is SavedConnection {
  if (typeof c !== 'object' || c === null) return false;
  const obj = c as Record<string, unknown>;

  // name: non-empty string without spaces
  if (typeof obj.name !== 'string' || obj.name.length === 0 || obj.name.includes(' ')) {
    return false;
  }

  // endpoint: non-empty string and valid URL
  if (typeof obj.endpoint !== 'string' || !isValidUrl(obj.endpoint)) {
    return false;
  }

  // accessKeyId: non-empty string
  if (typeof obj.accessKeyId !== 'string' || obj.accessKeyId.length === 0) {
    return false;
  }

  // bucket: optional, but if present must be string
  if (obj.bucket !== undefined && typeof obj.bucket !== 'string') {
    return false;
  }

  // region: optional, but if present must be string
  if (obj.region !== undefined && typeof obj.region !== 'string') {
    return false;
  }

  // autoDetectRegion: boolean
  if (typeof obj.autoDetectRegion !== 'boolean') {
    return false;
  }

  // lastUsedAt: number
  if (typeof obj.lastUsedAt !== 'number') {
    return false;
  }

  return true;
}

function loadConnections(): SavedConnection[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidSavedConnection);
  } catch {
    return [];
  }
}

function persistConnections(connections: SavedConnection[]): void {
  let toSave = [...connections];

  while (toSave.length > 0) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error(
          `localStorage quota exceeded for key "${STORAGE_KEY}" with ${toSave.length} connections, trimming oldest entry`,
          error
        );
        // Remove oldest entry (last in array since sorted by lastUsedAt descending) and retry
        toSave = toSave.slice(0, -1);
      } else {
        console.error(
          `Failed to persist connections to localStorage key "${STORAGE_KEY}"`,
          error
        );
        return;
      }
    }
  }
}

export function useConnectionHistory() {
  const [connections, setConnections] = useState<SavedConnection[]>(loadConnections);

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
