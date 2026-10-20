import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { getAuthStatus, login as apiLogin, logout as apiLogout } from '../services/api/auth';
import { ApiHttpError } from '../services/api/client';
import { onUnauthorized } from '../services/api/session-events';
import { queryClient } from '../queries/client';

interface SessionState {
  isLoggedIn: boolean;
  isCheckingSession: boolean;
  serverError: string | null;
}

type SessionAction =
  | { type: 'CHECK_START' }
  | { type: 'CHECK_DONE'; isLoggedIn: boolean }
  | { type: 'CHECK_FAILED'; error: string }
  | { type: 'LOGGED_IN' }
  | { type: 'LOGGED_OUT' };

function reducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'CHECK_START':
      return { ...state, isCheckingSession: true, serverError: null };
    case 'CHECK_DONE':
      return { isLoggedIn: action.isLoggedIn, isCheckingSession: false, serverError: null };
    case 'CHECK_FAILED':
      return { isLoggedIn: false, isCheckingSession: false, serverError: action.error };
    case 'LOGGED_IN':
      return { isLoggedIn: true, isCheckingSession: false, serverError: null };
    case 'LOGGED_OUT':
      return { isLoggedIn: false, isCheckingSession: false, serverError: null };
  }
}

export interface SessionContextValue {
  isLoggedIn: boolean;
  isCheckingSession: boolean;
  /** Set when the server itself could not be reached during the initial check. */
  serverError: string | null;
  /** Resolves when signed in; rejects with the server's message otherwise. */
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-run the initial session check after a server error. */
  retry: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const SERVER_UNREACHABLE = 'Unable to connect to server. Please ensure the server is running.';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    isLoggedIn: false,
    isCheckingSession: true,
    serverError: null,
  });
  const isLoggedInRef = useRef(state.isLoggedIn);
  isLoggedInRef.current = state.isLoggedIn;

  const checkSession = useCallback(async (signal?: AbortSignal) => {
    dispatch({ type: 'CHECK_START' });
    try {
      const status = await getAuthStatus(signal);
      if (!signal?.aborted) {
        dispatch({ type: 'CHECK_DONE', isLoggedIn: status.authenticated });
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return;
      }
      // /auth/status itself never 401s; any failure means the server is unreachable or broken.
      const message = error instanceof ApiHttpError && error.status !== 0 ? error.message : SERVER_UNREACHABLE;
      dispatch({ type: 'CHECK_FAILED', error: message });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void checkSession(controller.signal);
    return () => controller.abort();
  }, [checkSession]);

  // The API client reports a rejected cookie; drop the session once and send
  // the user to the login page (RequireAuth does the redirect).
  useEffect(() => {
    return onUnauthorized(() => {
      if (!isLoggedInRef.current) return;
      isLoggedInRef.current = false;
      dispatch({ type: 'LOGGED_OUT' });
      toast.error('Your session expired. Sign in again.');
    });
  }, []);

  // Once nothing under RequireAuth is mounted any more, forget everything fetched for that session.
  useEffect(() => {
    if (!state.isLoggedIn && !state.isCheckingSession) {
      queryClient.clear();
    }
  }, [state.isLoggedIn, state.isCheckingSession]);

  const login = useCallback(async (password: string) => {
    await apiLogin({ password });
    dispatch({ type: 'LOGGED_IN' });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // The cookie is gone from our point of view either way.
    }
    dispatch({ type: 'LOGGED_OUT' });
  }, []);

  const retry = useCallback(() => {
    void checkSession();
  }, [checkSession]);

  const value = useMemo<SessionContextValue>(
    () => ({ ...state, login, logout, retry }),
    [state, login, logout, retry],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
