import {
  createContext,
  useReducer,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import type { S3ClientContextValue, UserLoginCredentials } from '../types';
import {
  login,
  logout,
  getAuthStatus,
  selectBucket as apiSelectBucket,
  userLogin as apiUserLogin,
  activateConnection as apiActivateConnection,
  type LoginCredentials,
} from '../services/api';

interface SessionInfo {
  region: string;
  bucket: string | null;
}

interface S3ClientState {
  session: SessionInfo | null;
  isConnected: boolean;
  isUserLoggedIn: boolean;
  username: string | null;
  activeConnectionId: number | null;
  isCheckingSession: boolean;
  isLoggingIn: boolean;
  error: string | null;
}

type S3ClientAction =
  | { type: 'USER_LOGIN_START' }
  | { type: 'USER_LOGIN_SUCCESS'; username: string }
  | { type: 'USER_LOGIN_ERROR'; error: string }
  | { type: 'CONNECT_START' }
  | { type: 'CONNECT_SUCCESS'; session: SessionInfo; connectionId: number; username?: string }
  | { type: 'CONNECT_ERROR'; error: string }
  | { type: 'DISCONNECT' }
  | { type: 'BUCKET_SELECTED'; bucket: string }
  | { type: 'BUCKET_SELECT_ERROR'; error: string }
  | { type: 'SESSION_CHECK_COMPLETE'; isUserLoggedIn?: boolean; username?: string; activeConnectionId?: number | null };

function reducer(state: S3ClientState, action: S3ClientAction): S3ClientState {
  switch (action.type) {
    case 'USER_LOGIN_START':
      return { ...state, isLoggingIn: true, error: null };
    case 'USER_LOGIN_SUCCESS':
      return {
        ...state,
        isUserLoggedIn: true,
        username: action.username,
        isLoggingIn: false,
        error: null,
      };
    case 'USER_LOGIN_ERROR':
      return {
        ...state,
        isUserLoggedIn: false,
        username: null,
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
        // Set user login state atomically if username is provided
        ...(action.username && {
          isUserLoggedIn: true,
          username: action.username,
        }),
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
        isUserLoggedIn: false,
        username: null,
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
        isUserLoggedIn: action.isUserLoggedIn ?? state.isUserLoggedIn,
        username: action.username ?? state.username,
        activeConnectionId: action.activeConnectionId ?? state.activeConnectionId,
      };
    default:
      return state;
  }
}

const initialState: S3ClientState = {
  session: null,
  isConnected: false,
  isUserLoggedIn: false,
  username: null,
  activeConnectionId: null,
  isCheckingSession: true,
  isLoggingIn: false,
  error: null,
};

export const S3ClientContext = createContext<S3ClientContextValue | null>(null);

export function S3ClientProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const userLogin = useCallback(async (credentials: UserLoginCredentials): Promise<boolean> => {
    dispatch({ type: 'USER_LOGIN_START' });

    try {
      const response = await apiUserLogin(credentials);
      dispatch({
        type: 'USER_LOGIN_SUCCESS',
        username: response.username,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to login';
      dispatch({ type: 'USER_LOGIN_ERROR', error: message });
      return false;
    }
  }, []);

  const connect = useCallback(async (credentials: LoginCredentials): Promise<{ success: boolean; connectionId?: number }> => {
    dispatch({ type: 'CONNECT_START' });

    try {
      const response = await login(credentials);
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
      const response = await apiActivateConnection(connectionId, bucket);
      dispatch({
        type: 'CONNECT_SUCCESS',
        session: { region: response.region, bucket: response.bucket },
        connectionId: response.connectionId,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to activate connection';
      dispatch({ type: 'CONNECT_ERROR', error: message });
      return false;
    }
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
          if (status.authenticated && status.region && status.activeConnectionId) {
            // Fully authenticated with S3 credentials - dispatch atomically with user info
            dispatch({
              type: 'CONNECT_SUCCESS',
              session: { region: status.region, bucket: status.bucket || null },
              connectionId: status.activeConnectionId,
              username: status.userLoggedIn && status.username ? status.username : undefined,
            });
          } else if (status.userLoggedIn && status.username) {
            // User logged in but no S3 credentials yet
            dispatch({
              type: 'SESSION_CHECK_COMPLETE',
              isUserLoggedIn: true,
              username: status.username,
              activeConnectionId: status.activeConnectionId ?? null,
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
    isUserLoggedIn: state.isUserLoggedIn,
    username: state.username,
    activeConnectionId: state.activeConnectionId,
    isCheckingSession: state.isCheckingSession,
    requiresBucketSelection,
    error: state.error,
    userLogin,
    connect,
    disconnect,
    activateConnection,
    selectBucket,
  };

  return (
    <S3ClientContext.Provider value={value}>{children}</S3ClientContext.Provider>
  );
}
