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
  disconnectS3 as apiDisconnectS3,
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
  isCheckingSession: boolean;
  error: string | null;
}

type S3ClientAction =
  | { type: 'USER_LOGIN_START' }
  | { type: 'USER_LOGIN_SUCCESS'; username: string }
  | { type: 'USER_LOGIN_ERROR'; error: string }
  | { type: 'CONNECT_START' }
  | { type: 'CONNECT_SUCCESS'; session: SessionInfo }
  | { type: 'CONNECT_ERROR'; error: string }
  | { type: 'DISCONNECT' }
  | { type: 'DISCONNECT_S3' }
  | { type: 'BUCKET_SELECTED'; bucket: string }
  | { type: 'BUCKET_SELECT_ERROR'; error: string }
  | { type: 'SESSION_CHECK_COMPLETE'; isUserLoggedIn?: boolean; username?: string };

function reducer(state: S3ClientState, action: S3ClientAction): S3ClientState {
  switch (action.type) {
    case 'USER_LOGIN_START':
      return { ...state, error: null };
    case 'USER_LOGIN_SUCCESS':
      return {
        ...state,
        isUserLoggedIn: true,
        username: action.username,
        isCheckingSession: false,
        error: null,
      };
    case 'USER_LOGIN_ERROR':
      return {
        ...state,
        isUserLoggedIn: false,
        username: null,
        isCheckingSession: false,
        error: action.error,
      };
    case 'CONNECT_START':
      return { ...state, error: null };
    case 'CONNECT_SUCCESS':
      return {
        ...state,
        session: action.session,
        isConnected: true,
        isCheckingSession: false,
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
        isCheckingSession: false,
        error: null,
      };
    case 'DISCONNECT_S3':
      return {
        ...state,
        session: null,
        isConnected: false,
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
  isCheckingSession: true,
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

  const disconnectS3 = useCallback(async () => {
    try {
      await apiDisconnectS3();
    } catch {
      // Ignore errors
    }
    dispatch({ type: 'DISCONNECT_S3' });
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
            // Fully authenticated with S3 credentials
            dispatch({
              type: 'CONNECT_SUCCESS',
              session: { region: status.region, bucket: status.bucket || null },
            });
            // Also set user login state
            if (status.userLoggedIn && status.username) {
              dispatch({
                type: 'USER_LOGIN_SUCCESS',
                username: status.username,
              });
            }
          } else if (status.userLoggedIn && status.username) {
            // User logged in but no S3 credentials yet
            dispatch({
              type: 'SESSION_CHECK_COMPLETE',
              isUserLoggedIn: true,
              username: status.username,
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
    isCheckingSession: state.isCheckingSession,
    requiresBucketSelection,
    error: state.error,
    userLogin,
    connect,
    disconnect,
    disconnectS3,
    selectBucket,
  };

  return (
    <S3ClientContext.Provider value={value}>{children}</S3ClientContext.Provider>
  );
}
