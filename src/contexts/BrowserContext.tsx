import {
  createContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useParams } from 'react-router';
import type { S3Object, BrowserContextValue } from '../types';
import { useS3ClientContext } from './useS3ClientContext';
import { listObjects, ApiHttpError } from '../services/api';
import { getPathSegments, sortObjects } from '../utils/formatters';
import { decodeUrlToS3Path } from '../utils/urlEncoding';
import { BROWSE_WINDOW_LIMIT } from '../config/browse';

interface BrowserState {
  objects: S3Object[];
  isLoading: boolean;
  error: string | null;
  isLimited: boolean;
  limitMessage: string | null;
  limitContinuationToken: string | null;
  windowStart: number;
  windowTokens: Array<string | null>;
  windowIndex: number;
}

type BrowserAction =
  | { type: 'FETCH_START'; windowStart: number; windowIndex: number; windowTokens: Array<string | null> }
  | { type: 'FETCH_SUCCESS'; objects: S3Object[] }
  | { type: 'FETCH_ERROR'; error: string }
  | { type: 'FETCH_LIMIT_REACHED'; objects: S3Object[]; message: string; continuationToken: string | null }
  | { type: 'RESET' };

function reducer(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case 'FETCH_START':
      return {
        ...state,
        isLoading: true,
        error: null,
        isLimited: false,
        limitMessage: null,
        limitContinuationToken: null,
        windowStart: action.windowStart,
        windowIndex: action.windowIndex,
        windowTokens: action.windowTokens,
      };
    case 'FETCH_SUCCESS':
      return {
        ...state,
        isLoading: false,
        objects: action.objects,
        error: null,
        isLimited: false,
        limitMessage: null,
        limitContinuationToken: null,
      };
    case 'FETCH_ERROR':
      return {
        ...state,
        isLoading: false,
        error: action.error,
        isLimited: false,
        limitMessage: null,
        limitContinuationToken: null,
      };
    case 'FETCH_LIMIT_REACHED':
      return {
        ...state,
        isLoading: false,
        objects: action.objects,
        error: null,
        isLimited: true,
        limitMessage: action.message,
        limitContinuationToken: action.continuationToken,
      };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

const initialState: BrowserState = {
  objects: [],
  isLoading: true,
  error: null,
  isLimited: false,
  limitMessage: null,
  limitContinuationToken: null,
  windowStart: 0,
  windowTokens: [null],
  windowIndex: 0,
};

const MAX_OBJECTS = BROWSE_WINDOW_LIMIT;

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
  const [showVersions, setShowVersions] = useState(false);
  const [versioningSupported, setVersioningSupported] = useState(true);
  const { isConnected, activeConnectionId, credentials } = useS3ClientContext();
  const navigate = useNavigate();
  const { '*': splatPath, bucket: urlBucket } = useParams<{ '*': string; bucket: string }>();
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastFetchedPathRef = useRef<string | null>(null);
  const lastFetchedVersionsRef = useRef<boolean | null>(null);

  // Get bucket from URL params or credentials
  const bucket = urlBucket || credentials?.bucket;

  // Current path derived from URL (or initial path on first render)
  // Use trailing slash for folder-style S3 prefixes
  const currentPath = splatPath !== undefined
    ? decodeUrlToS3Path(splatPath, true)
    : initialPath;

  const buildLimitMessage = useCallback((windowStart: number, count: number) => {
    if (count === 0) {
      return `Results limited because this folder contains more than ${MAX_OBJECTS} items.`;
    }
    const startIndex = windowStart + 1;
    const endIndex = windowStart + count;
    return `Results limited to items ${startIndex}-${endIndex} because this folder contains more than ${MAX_OBJECTS} results.`;
  }, []);

  const fetchObjectsWindow = useCallback(
    async (
      path: string,
      startToken: string | undefined,
      windowIndex: number,
      windowTokens: Array<string | null>
    ) => {
      if (!isConnected || !activeConnectionId || !bucket) return;

      // Abort any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const requestId = ++requestIdRef.current;
      dispatch({ type: 'FETCH_START', windowStart: windowIndex * MAX_OBJECTS, windowIndex, windowTokens });

      try {
        const aggregated: S3Object[] = [];
        let continuationToken: string | undefined = startToken;

        do {
          const result = await listObjects(
            activeConnectionId,
            bucket,
            path,
            showVersions,
            continuationToken,
            abortController.signal
          );

          if (requestId !== requestIdRef.current) {
            return;
          }

          if (aggregated.length + result.objects.length > MAX_OBJECTS) {
            if (requestId === requestIdRef.current) {
              const limitedObjects = sortObjects(aggregated);
              dispatch({
                type: 'FETCH_LIMIT_REACHED',
                objects: limitedObjects,
                message: buildLimitMessage(windowIndex * MAX_OBJECTS, limitedObjects.length),
                continuationToken: continuationToken ?? null,
              });
              lastFetchedPathRef.current = path;
              lastFetchedVersionsRef.current = showVersions;
            }
            return;
          }

          aggregated.push(...result.objects);

          if (aggregated.length >= MAX_OBJECTS && result.isTruncated) {
            if (requestId === requestIdRef.current) {
              const limitedObjects = sortObjects(aggregated.slice(0, MAX_OBJECTS));
              dispatch({
                type: 'FETCH_LIMIT_REACHED',
                objects: limitedObjects,
                message: buildLimitMessage(windowIndex * MAX_OBJECTS, limitedObjects.length),
                continuationToken: result.continuationToken ?? null,
              });
              lastFetchedPathRef.current = path;
              lastFetchedVersionsRef.current = showVersions;
            }
            return;
          }

          continuationToken = result.isTruncated ? result.continuationToken : undefined;
        } while (continuationToken);

        if (requestId === requestIdRef.current) {
          // Sort client-side: folders first, then files, alphabetically
          dispatch({
            type: 'FETCH_SUCCESS',
            objects: sortObjects(aggregated),
          });
          lastFetchedPathRef.current = path;
          lastFetchedVersionsRef.current = showVersions;
        }
      } catch (err) {
        // Skip dispatch for aborted requests
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        // Handle versioning not supported (501 NotImplemented)
        if (err instanceof ApiHttpError && err.status === 501 && err.code === 'NotImplemented') {
          setVersioningSupported(false);
          setShowVersions(false);
          // Set lastFetchedVersionsRef to true so the useEffect sees a change
          // (true !== false) and triggers a refetch without versions
          lastFetchedVersionsRef.current = true;
          return;
        }
        if (requestId === requestIdRef.current) {
          const message = err instanceof Error ? err.message : 'Failed to list objects';
          dispatch({ type: 'FETCH_ERROR', error: message });
        }
      }
    },
    [activeConnectionId, bucket, buildLimitMessage, isConnected, showVersions]
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
    await fetchObjectsWindow(currentPath, undefined, 0, [null]);
  }, [currentPath, fetchObjectsWindow]);

  const loadNextWindow = useCallback(async () => {
    if (!state.limitContinuationToken) {
      return;
    }
    const nextIndex = state.windowIndex + 1;
    const nextTokens = [...state.windowTokens];
    nextTokens[nextIndex] = state.limitContinuationToken;
    await fetchObjectsWindow(currentPath, state.limitContinuationToken, nextIndex, nextTokens);
  }, [currentPath, fetchObjectsWindow, state.limitContinuationToken, state.windowIndex, state.windowTokens]);

  const loadPrevWindow = useCallback(async () => {
    if (state.windowIndex === 0) {
      return;
    }
    const prevIndex = state.windowIndex - 1;
    const startToken = state.windowTokens[prevIndex] ?? undefined;
    await fetchObjectsWindow(currentPath, startToken, prevIndex, state.windowTokens);
  }, [currentPath, fetchObjectsWindow, state.windowIndex, state.windowTokens]);

  // Reset when disconnected
  useEffect(() => {
    if (!isConnected) {
      dispatch({ type: 'RESET' });
      lastFetchedPathRef.current = null;
      lastFetchedVersionsRef.current = null;
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
      lastFetchedVersionsRef.current = null;
    };
  }, []);

  // Fetch objects when path changes (URL-driven)
  useEffect(() => {
    if (isConnected && lastFetchedPathRef.current !== currentPath) {
      void fetchObjectsWindow(currentPath, undefined, 0, [null]);
    }
  }, [isConnected, currentPath, fetchObjectsWindow]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }
    if (
      lastFetchedVersionsRef.current !== null &&
      lastFetchedVersionsRef.current !== showVersions
    ) {
      void fetchObjectsWindow(currentPath, undefined, 0, [null]);
    }
  }, [currentPath, fetchObjectsWindow, isConnected, showVersions]);

  const toggleShowVersions = useCallback(() => {
    setShowVersions((prev) => !prev);
  }, []);

  const value: BrowserContextValue = useMemo(
    () => ({
      currentPath,
      objects: state.objects,
      isLoading: state.isLoading,
      error: state.error,
      isLimited: state.isLimited,
      limitMessage: state.limitMessage,
      windowStart: state.windowStart,
      hasNextWindow: Boolean(state.limitContinuationToken),
      loadNextWindow,
      hasPrevWindow: state.windowIndex > 0,
      loadPrevWindow,
      navigateTo,
      navigateUp,
      refresh,
      pathSegments: getPathSegments(currentPath),
      showVersions,
      toggleShowVersions,
      versioningSupported,
    }),
    [
      currentPath,
      state.objects,
      state.isLoading,
      state.error,
      state.isLimited,
      state.limitMessage,
      state.windowStart,
      state.limitContinuationToken,
      loadNextWindow,
      state.windowIndex,
      loadPrevWindow,
      navigateTo,
      navigateUp,
      refresh,
      showVersions,
      toggleShowVersions,
      versioningSupported,
    ]
  );

  return (
    <BrowserContext.Provider value={value}>{children}</BrowserContext.Provider>
  );
}
