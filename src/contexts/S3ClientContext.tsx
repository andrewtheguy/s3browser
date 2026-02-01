import {
  createContext,
  useReducer,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import type { S3ClientContextValue, LoginCredentials, S3ConnectionCredentials } from '../types';
import {
  login as apiLogin,
  logout,
  getAuthStatus,
  saveConnection,
  getConnection,
} from '../services/api';

interface SessionInfo {
  region: string;
  bucket: string | null;
}

interface S3ClientState {
  session: SessionInfo | null;
  isConnected: boolean;
  isLoggedIn: boolean;
  activeConnectionId: number | null;
  isCheckingSession: boolean;
  isLoggingIn: boolean;
  error: string | null;
}

type S3ClientAction =
  | { type: 'LOGIN_START' }
  | { type: 'LOGIN_SUCCESS' }
  | { type: 'LOGIN_ERROR'; error: string }
  | { type: 'CONNECT_START' }
  | { type: 'CONNECT_SUCCESS'; session: SessionInfo; connectionId: number }
  | { type: 'CONNECT_ERROR'; error: string }
  | { type: 'DISCONNECT' }
  | { type: 'BUCKET_SELECTED'; bucket: string }
  | { type: 'BUCKET_SELECT_ERROR'; error: string }
  | { type: 'SESSION_CHECK_COMPLETE'; isLoggedIn?: boolean; activeConnectionId?: number | null };

function reducer(state: S3ClientState, action: S3ClientAction): S3ClientState {
  switch (action.type) {
    case 'LOGIN_START':
      return { ...state, isLoggingIn: true, error: null };
    case 'LOGIN_SUCCESS':
      return {
        ...state,
        isLoggedIn: true,
        isLoggingIn: false,
        error: null,
      };
    case 'LOGIN_ERROR':
      return {
        ...state,
        isLoggedIn: false,
        isLoggingIn: false,
        error: action.error,
      };
    case 'CONNECT_START':
      return { ...state, error: null };
    case 'CONNECT_SUCCESS':
      return {
        ...state,
        session: action.session,
        isConnected: true,
        activeConnectionId: action.connectionId,
        isCheckingSession: false,
        isLoggedIn: true,
        error: null,
      };
    case 'CONNECT_ERROR':
      return {
        ...state,
        session: null,
        isConnected: false,
        isCheckingSession: false,
        error: action.error,
      };
    case 'DISCONNECT':
      return {
        session: null,
        isConnected: false,
        isLoggedIn: false,
        activeConnectionId: null,
        isCheckingSession: false,
        isLoggingIn: false,
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
        isLoggedIn: action.isLoggedIn ?? state.isLoggedIn,
        activeConnectionId: action.activeConnectionId ?? state.activeConnectionId,
      };
    default:
      return state;
  }
}

const initialState: S3ClientState = {
  session: null,
  isConnected: false,
  isLoggedIn: false,
  activeConnectionId: null,
  isCheckingSession: true,
  isLoggingIn: false,
  error: null,
};

export const S3ClientContext = createContext<S3ClientContextValue | null>(null);

export function S3ClientProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const login = useCallback(async (credentials: LoginCredentials): Promise<boolean> => {
    dispatch({ type: 'LOGIN_START' });

    try {
      await apiLogin(credentials);
      dispatch({ type: 'LOGIN_SUCCESS' });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to login';
      dispatch({ type: 'LOGIN_ERROR', error: message });
      return false;
    }
  }, []);

  const connect = useCallback(async (credentials: S3ConnectionCredentials): Promise<{ success: boolean; connectionId?: number }> => {
    dispatch({ type: 'CONNECT_START' });

    try {
      const response = await saveConnection(credentials);
      dispatch({
        type: 'CONNECT_SUCCESS',
        session: { region: response.region, bucket: response.bucket },
        connectionId: response.connectionId,
      });
      return { success: true, connectionId: response.connectionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect';
      dispatch({ type: 'CONNECT_ERROR', error: message });
      return { success: false };
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

  const activateConnection = useCallback(async (connectionId: number, bucket?: string): Promise<boolean> => {
    dispatch({ type: 'CONNECT_START' });

    try {
      const connection = await getConnection(connectionId);
      dispatch({
        type: 'CONNECT_SUCCESS',
        session: { region: connection.region || 'us-east-1', bucket: bucket || connection.bucket },
        connectionId: connection.id,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to activate connection';
      dispatch({ type: 'CONNECT_ERROR', error: message });
      return false;
    }
  }, []);

  const selectBucket = useCallback((bucket: string): boolean => {
    // In stateless mode, just update local state - validation happens on first S3 request
    dispatch({ type: 'BUCKET_SELECTED', bucket });
    return true;
  }, []);

  // Check session status on mount
  useEffect(() => {
    const abortController = new AbortController();

    void (async () => {
      try {
        const status = await getAuthStatus(abortController.signal);
        if (!abortController.signal.aborted) {
          if (status.authenticated) {
            // User is logged in
            dispatch({
              type: 'SESSION_CHECK_COMPLETE',
              isLoggedIn: true,
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
    isLoggedIn: state.isLoggedIn,
    activeConnectionId: state.activeConnectionId,
    isCheckingSession: state.isCheckingSession,
    requiresBucketSelection,
    error: state.error,
    login,
    connect,
    disconnect,
    activateConnection,
    selectBucket,
  };

  return (
    <S3ClientContext.Provider value={value}>{children}</S3ClientContext.Provider>
  );
}
