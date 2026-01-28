import {
  createContext,
  useReducer,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import type { S3ClientContextValue } from '../types';
import { login, logout, getAuthStatus, type LoginCredentials } from '../services/api';

interface SessionInfo {
  region: string;
  bucket: string;
}

interface S3ClientState {
  session: SessionInfo | null;
  isConnected: boolean;
  error: string | null;
}

type S3ClientAction =
  | { type: 'CONNECT_START' }
  | { type: 'CONNECT_SUCCESS'; session: SessionInfo }
  | { type: 'CONNECT_ERROR'; error: string }
  | { type: 'DISCONNECT' };

function reducer(state: S3ClientState, action: S3ClientAction): S3ClientState {
  switch (action.type) {
    case 'CONNECT_START':
      return { ...state, error: null };
    case 'CONNECT_SUCCESS':
      return {
        session: action.session,
        isConnected: true,
        error: null,
      };
    case 'CONNECT_ERROR':
      return {
        session: null,
        isConnected: false,
        error: action.error,
      };
    case 'DISCONNECT':
      return {
        session: null,
        isConnected: false,
        error: null,
      };
    default:
      return state;
  }
}

const initialState: S3ClientState = {
  session: null,
  isConnected: false,
  error: null,
};

export const S3ClientContext = createContext<S3ClientContextValue | null>(null);

export function S3ClientProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const connect = useCallback(async (credentials: LoginCredentials): Promise<boolean> => {
    dispatch({ type: 'CONNECT_START' });

    try {
      const response = await login(credentials);
      dispatch({
        type: 'CONNECT_SUCCESS',
        session: { region: response.region, bucket: response.bucket },
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect';
      dispatch({ type: 'CONNECT_ERROR', error: message });
      return false;
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await logout();
    } catch {
      // Ignore logout errors
    }
    dispatch({ type: 'DISCONNECT' });
  }, []);

  // Check session status on mount
  useEffect(() => {
    const abortController = new AbortController();

    (async () => {
      try {
        const status = await getAuthStatus(abortController.signal);
        if (!abortController.signal.aborted && status.authenticated && status.region && status.bucket) {
          dispatch({
            type: 'CONNECT_SUCCESS',
            session: { region: status.region, bucket: status.bucket },
          });
        }
      } catch (error) {
        // Ignore abort errors from cleanup
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        // Log other errors - user stays disconnected (initial state)
        console.error('Session status check failed:', error);
      }
    })();

    return () => {
      abortController.abort();
    };
  }, []);

  const value: S3ClientContextValue = {
    credentials: state.session
      ? {
          accessKeyId: '', // Not exposed to frontend
          secretAccessKey: '', // Not exposed to frontend
          region: state.session.region,
          bucket: state.session.bucket,
        }
      : null,
    isConnected: state.isConnected,
    error: state.error,
    connect,
    disconnect,
  };

  return (
    <S3ClientContext.Provider value={value}>{children}</S3ClientContext.Provider>
  );
}
