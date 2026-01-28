import {
  createContext,
  useReducer,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import type { S3ClientContextValue } from '../types';
import { login, logout, getAuthStatus, selectBucket as apiSelectBucket, type LoginCredentials } from '../services/api';

interface SessionInfo {
  region: string;
  bucket: string | null;
}

interface S3ClientState {
  session: SessionInfo | null;
  isConnected: boolean;
  isCheckingSession: boolean;
  error: string | null;
}

type S3ClientAction =
  | { type: 'CONNECT_START' }
  | { type: 'CONNECT_SUCCESS'; session: SessionInfo }
  | { type: 'CONNECT_ERROR'; error: string }
  | { type: 'DISCONNECT' }
  | { type: 'BUCKET_SELECTED'; bucket: string }
  | { type: 'BUCKET_SELECT_ERROR'; error: string }
  | { type: 'SESSION_CHECK_COMPLETE' };

function reducer(state: S3ClientState, action: S3ClientAction): S3ClientState {
  switch (action.type) {
    case 'CONNECT_START':
      return { ...state, error: null };
    case 'CONNECT_SUCCESS':
      return {
        session: action.session,
        isConnected: true,
        isCheckingSession: false,
        error: null,
      };
    case 'CONNECT_ERROR':
      return {
        session: null,
        isConnected: false,
        isCheckingSession: false,
        error: action.error,
      };
    case 'DISCONNECT':
      return {
        session: null,
        isConnected: false,
        isCheckingSession: false,
        error: null,
      };
    case 'BUCKET_SELECTED':
      return {
        ...state,
        session: state.session ? { ...state.session, bucket: action.bucket } : null,
        error: null,
      };
    case 'BUCKET_SELECT_ERROR':
      return {
        ...state,
        error: action.error,
      };
    case 'SESSION_CHECK_COMPLETE':
      return {
        ...state,
        isCheckingSession: false,
      };
    default:
      return state;
  }
}

const initialState: S3ClientState = {
  session: null,
  isConnected: false,
  isCheckingSession: true,
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

  const selectBucket = useCallback(async (bucket: string): Promise<boolean> => {
    try {
      await apiSelectBucket(bucket);
      dispatch({ type: 'BUCKET_SELECTED', bucket });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to select bucket';
      dispatch({ type: 'BUCKET_SELECT_ERROR', error: message });
      return false;
    }
  }, []);

  // Check session status on mount
  useEffect(() => {
    const abortController = new AbortController();

    void (async () => {
      try {
        const status = await getAuthStatus(abortController.signal);
        if (!abortController.signal.aborted) {
          if (status.authenticated && status.region) {
            dispatch({
              type: 'CONNECT_SUCCESS',
              session: { region: status.region, bucket: status.bucket || null },
            });
          } else {
            dispatch({ type: 'SESSION_CHECK_COMPLETE' });
          }
        }
      } catch (error) {
        // Ignore abort errors from cleanup
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        // Log other errors - user stays disconnected (initial state)
        console.error('Session status check failed:', error);
        dispatch({ type: 'SESSION_CHECK_COMPLETE' });
      }
    })();

    return () => {
      abortController.abort();
    };
  }, []);

  const requiresBucketSelection = state.isConnected && !state.session?.bucket;

  const value: S3ClientContextValue = {
    credentials: state.session
      ? {
          accessKeyId: '', // Not exposed to frontend
          secretAccessKey: '', // Not exposed to frontend
          region: state.session.region,
          bucket: state.session.bucket || undefined,
        }
      : null,
    isConnected: state.isConnected,
    isCheckingSession: state.isCheckingSession,
    requiresBucketSelection,
    error: state.error,
    connect,
    disconnect,
    selectBucket,
  };

  return (
    <S3ClientContext.Provider value={value}>{children}</S3ClientContext.Provider>
  );
}
