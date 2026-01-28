import {
  createContext,
  useReducer,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import type { S3Object, BrowserContextValue } from '../types';
import { useS3ClientContext } from './useS3ClientContext';
import { listObjects } from '../services/s3';
import { getPathSegments } from '../utils/formatters';

interface BrowserState {
  currentPath: string;
  objects: S3Object[];
  isLoading: boolean;
  error: string | null;
}

type BrowserAction =
  | { type: 'SET_PATH'; path: string }
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; objects: S3Object[] }
  | { type: 'FETCH_ERROR'; error: string }
  | { type: 'RESET' };

function reducer(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case 'SET_PATH':
      return { ...state, currentPath: action.path };
    case 'FETCH_START':
      return { ...state, isLoading: true, error: null };
    case 'FETCH_SUCCESS':
      return { ...state, isLoading: false, objects: action.objects, error: null };
    case 'FETCH_ERROR':
      return { ...state, isLoading: false, error: action.error };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

const initialState: BrowserState = {
  currentPath: '',
  objects: [],
  isLoading: false,
  error: null,
};

export const BrowserContext = createContext<BrowserContextValue | null>(null);

export function BrowserProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { client, credentials, isConnected } = useS3ClientContext();

  const fetchObjects = useCallback(
    async (path: string) => {
      if (!client || !credentials) return;

      dispatch({ type: 'FETCH_START' });

      try {
        const result = await listObjects({
          client,
          bucket: credentials.bucket,
          prefix: path,
        });
        dispatch({ type: 'FETCH_SUCCESS', objects: result.objects });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to list objects';
        dispatch({ type: 'FETCH_ERROR', error: message });
      }
    },
    [client, credentials]
  );

  const navigateTo = useCallback(
    (path: string) => {
      dispatch({ type: 'SET_PATH', path });
      fetchObjects(path);
    },
    [fetchObjects]
  );

  const navigateUp = useCallback(() => {
    const segments = getPathSegments(state.currentPath);
    if (segments.length === 0) return;

    segments.pop();
    const newPath = segments.length > 0 ? segments.join('/') + '/' : '';
    navigateTo(newPath);
  }, [state.currentPath, navigateTo]);

  const refresh = useCallback(async () => {
    await fetchObjects(state.currentPath);
  }, [state.currentPath, fetchObjects]);

  // Reset when disconnected
  useEffect(() => {
    if (!isConnected) {
      dispatch({ type: 'RESET' });
    }
  }, [isConnected]);

  // Fetch objects when connected
  useEffect(() => {
    if (isConnected && client && credentials) {
      fetchObjects(state.currentPath);
    }
  }, [isConnected, client, credentials, fetchObjects, state.currentPath]);

  const value: BrowserContextValue = {
    currentPath: state.currentPath,
    objects: state.objects,
    isLoading: state.isLoading,
    error: state.error,
    navigateTo,
    navigateUp,
    refresh,
    pathSegments: getPathSegments(state.currentPath),
  };

  return (
    <BrowserContext.Provider value={value}>{children}</BrowserContext.Provider>
  );
}

