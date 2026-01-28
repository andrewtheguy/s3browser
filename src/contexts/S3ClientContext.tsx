import {
  createContext,
  useReducer,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import type { S3Credentials, S3ClientContextValue } from '../types';
import { createS3Client } from '../services/s3';

const STORAGE_KEY = 's3browser_credentials';

interface S3ClientState {
  client: S3Client | null;
  credentials: S3Credentials | null;
  isConnected: boolean;
  error: string | null;
}

type S3ClientAction =
  | { type: 'CONNECT_START' }
  | { type: 'CONNECT_SUCCESS'; client: S3Client; credentials: S3Credentials }
  | { type: 'CONNECT_ERROR'; error: string }
  | { type: 'DISCONNECT' };

function reducer(state: S3ClientState, action: S3ClientAction): S3ClientState {
  switch (action.type) {
    case 'CONNECT_START':
      return { ...state, error: null };
    case 'CONNECT_SUCCESS':
      return {
        client: action.client,
        credentials: action.credentials,
        isConnected: true,
        error: null,
      };
    case 'CONNECT_ERROR':
      return {
        client: null,
        credentials: null,
        isConnected: false,
        error: action.error,
      };
    case 'DISCONNECT':
      return {
        client: null,
        credentials: null,
        isConnected: false,
        error: null,
      };
    default:
      return state;
  }
}

const initialState: S3ClientState = {
  client: null,
  credentials: null,
  isConnected: false,
  error: null,
};

export const S3ClientContext = createContext<S3ClientContextValue | null>(null);

export function S3ClientProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const connect = useCallback(async (credentials: S3Credentials) => {
    dispatch({ type: 'CONNECT_START' });

    try {
      const client = createS3Client(credentials);

      // Test the connection by listing buckets or making a headBucket call
      // For simplicity, we'll just try to create the client and assume it works
      // The actual validation will happen when listing objects
      try {
        await client.send(new ListBucketsCommand({}));
      } catch {
        // If ListBuckets fails (common for restricted IAM), that's okay
        // The credentials might still work for the specific bucket
      }

      // Save to session storage
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));

      dispatch({ type: 'CONNECT_SUCCESS', client, credentials });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect';
      dispatch({ type: 'CONNECT_ERROR', error: message });
      throw err;
    }
  }, []);

  const disconnect = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    dispatch({ type: 'DISCONNECT' });
  }, []);

  // Auto-load credentials from session storage on mount
  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const credentials = JSON.parse(stored) as S3Credentials;
        connect(credentials).catch(() => {
          // If auto-connect fails, clear storage
          sessionStorage.removeItem(STORAGE_KEY);
        });
      } catch {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    }
  }, [connect]);

  const value: S3ClientContextValue = {
    client: state.client,
    credentials: state.credentials,
    isConnected: state.isConnected,
    error: state.error,
    connect,
    disconnect,
  };

  return (
    <S3ClientContext.Provider value={value}>{children}</S3ClientContext.Provider>
  );
}

