import {
  createContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { useNavigate, useParams } from 'react-router';
import type { S3Object, BrowserContextValue } from '../types';
import { useS3ClientContext } from './useS3ClientContext';
import { listObjects } from '../services/api';
import { getPathSegments, sortObjects } from '../utils/formatters';
import { decodeUrlToS3Path } from '../utils/urlEncoding';

interface BrowserState {
  objects: S3Object[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  continuationToken?: string;
  isTruncated: boolean;
}

type BrowserAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; objects: S3Object[]; continuationToken?: string; isTruncated: boolean }
  | { type: 'FETCH_ERROR'; error: string }
  | { type: 'LOAD_MORE_START' }
  | { type: 'LOAD_MORE_SUCCESS'; objects: S3Object[]; continuationToken?: string; isTruncated: boolean }
  | { type: 'LOAD_MORE_ERROR'; error: string }
  | { type: 'RESET' };

function reducer(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, isLoading: true, error: null };
    case 'FETCH_SUCCESS':
      return {
        ...state,
        isLoading: false,
        objects: action.objects,
        error: null,
        continuationToken: action.continuationToken,
        isTruncated: action.isTruncated,
      };
    case 'FETCH_ERROR':
      return { ...state, isLoading: false, error: action.error };
    case 'LOAD_MORE_START':
      return { ...state, isLoadingMore: true, error: null };
    case 'LOAD_MORE_SUCCESS':
      return {
        ...state,
        isLoadingMore: false,
        objects: action.objects,
        continuationToken: action.continuationToken,
        isTruncated: action.isTruncated,
      };
    case 'LOAD_MORE_ERROR':
      return { ...state, isLoadingMore: false, error: action.error };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

const initialState: BrowserState = {
  objects: [],
  isLoading: false,
  isLoadingMore: false,
  error: null,
  continuationToken: undefined,
  isTruncated: false,
};

export const BrowserContext = createContext<BrowserContextValue | null>(null);

interface BrowserProviderProps {
  children: ReactNode;
  initialPath?: string;
  buildUrl: (path: string) => string;
}

export function BrowserProvider({
  children,
  initialPath = '',
  buildUrl,
}: BrowserProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const navigate = useNavigate();
  const { '*': splatPath, bucket: urlBucket } = useParams<{ '*': string; bucket: string }>();
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastFetchedPathRef = useRef<string | null>(null);

  // Get bucket from URL params or credentials
  const bucket = urlBucket || credentials?.bucket;

  // Current path derived from URL (or initial path on first render)
  // Use trailing slash for folder-style S3 prefixes
  const currentPath = splatPath !== undefined
    ? decodeUrlToS3Path(splatPath, true)
    : initialPath;

  const fetchObjects = useCallback(
    async (path: string) => {
      if (!isConnected || !activeConnectionId || !bucket) return;

      // Abort any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const requestId = ++requestIdRef.current;
      dispatch({ type: 'FETCH_START' });

      try {
        const result = await listObjects(activeConnectionId, bucket, path, undefined, abortController.signal);
        if (requestId === requestIdRef.current) {
          // Sort client-side: folders first, then files, alphabetically
          dispatch({
            type: 'FETCH_SUCCESS',
            objects: sortObjects(result.objects),
            continuationToken: result.continuationToken,
            isTruncated: result.isTruncated,
          });
          lastFetchedPathRef.current = path;
        }
      } catch (err) {
        // Skip dispatch for aborted requests
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        if (requestId === requestIdRef.current) {
          const message = err instanceof Error ? err.message : 'Failed to list objects';
          dispatch({ type: 'FETCH_ERROR', error: message });
        }
      }
    },
    [isConnected, activeConnectionId, bucket]
  );

  const navigateTo = useCallback(
    (path: string) => {
      void navigate(buildUrl(path));
    },
    [navigate, buildUrl]
  );

  const navigateUp = useCallback(() => {
    const segments = getPathSegments(currentPath);
    if (segments.length === 0) return;

    segments.pop();
    const newPath = segments.length > 0 ? segments.join('/') + '/' : '';
    navigateTo(newPath);
  }, [currentPath, navigateTo]);

  const refresh = useCallback(async () => {
    await fetchObjects(currentPath);
  }, [currentPath, fetchObjects]);

  const loadMore = useCallback(async () => {
    if (!state.continuationToken || state.isLoadingMore || !isConnected || !activeConnectionId || !bucket) return;

    dispatch({ type: 'LOAD_MORE_START' });
    try {
      const result = await listObjects(activeConnectionId, bucket, currentPath, state.continuationToken);
      // Append new objects to existing, re-sort
      dispatch({
        type: 'LOAD_MORE_SUCCESS',
        objects: sortObjects([...state.objects, ...result.objects]),
        continuationToken: result.continuationToken,
        isTruncated: result.isTruncated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load more objects';
      dispatch({ type: 'LOAD_MORE_ERROR', error: message });
    }
  }, [state.continuationToken, state.isLoadingMore, state.objects, isConnected, activeConnectionId, bucket, currentPath]);

  // Reset when disconnected
  useEffect(() => {
    if (!isConnected) {
      dispatch({ type: 'RESET' });
      lastFetchedPathRef.current = null;
    }
  }, [isConnected]);

  // Abort pending requests on unmount
  useEffect(() => {
    const abortController = abortControllerRef;
    return () => {
      if (abortController.current) {
        abortController.current.abort();
        abortController.current = null;
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally modify refs at cleanup time
      requestIdRef.current++;
      lastFetchedPathRef.current = null;
    };
  }, []);

  // Fetch objects when path changes (URL-driven)
  useEffect(() => {
    if (isConnected && lastFetchedPathRef.current !== currentPath) {
      void fetchObjects(currentPath);
    }
  }, [isConnected, currentPath, fetchObjects]);

  const value: BrowserContextValue = useMemo(
    () => ({
      currentPath,
      objects: state.objects,
      isLoading: state.isLoading,
      error: state.error,
      navigateTo,
      navigateUp,
      refresh,
      pathSegments: getPathSegments(currentPath),
      continuationToken: state.continuationToken,
      isTruncated: state.isTruncated,
      isLoadingMore: state.isLoadingMore,
      loadMore,
    }),
    [currentPath, state.objects, state.isLoading, state.error, navigateTo, navigateUp, refresh, state.continuationToken, state.isTruncated, state.isLoadingMore, loadMore]
  );

  return (
    <BrowserContext.Provider value={value}>{children}</BrowserContext.Provider>
  );
}
