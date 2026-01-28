import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Box, CircularProgress, Alert } from '@mui/material';
import { BrowserProvider, useS3ClientContext } from '../contexts';
import { S3Browser } from '../components/S3Browser';
import { decodeUrlToS3Path, buildBrowseUrl } from '../utils/urlEncoding';

export function BrowsePage() {
  const { bucket, '*': splatPath } = useParams<{ bucket: string; '*': string }>();
  const { isConnected, credentials, selectBucket } = useS3ClientContext();
  const navigate = useNavigate();
  const [isSelectingBucket, setIsSelectingBucket] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectingRef = useRef(false);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Decode the URL path to S3 path (with trailing slash for folder-style prefix)
  const initialPath = useMemo(
    () => decodeUrlToS3Path(splatPath || '', true),
    [splatPath]
  );

  // Memoize buildUrl to prevent unnecessary re-renders in BrowserProvider
  const buildUrl = useCallback(
    (path: string) => (bucket ? buildBrowseUrl(bucket, path) : '/'),
    [bucket]
  );

  const doSelectBucket = useCallback(async (bucketName: string) => {
    if (selectingRef.current) return;
    selectingRef.current = true;
    setIsSelectingBucket(true);
    setError(null);

    // Clear any pending timeout from previous attempts
    if (timeoutIdRef.current) {
      clearTimeout(timeoutIdRef.current);
      timeoutIdRef.current = null;
    }

    try {
      const success = await selectBucket(bucketName);
      if (!success) {
        setError(`Failed to access bucket: ${bucketName}`);
        timeoutIdRef.current = setTimeout(() => void navigate('/', { replace: true }), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select bucket');
      timeoutIdRef.current = setTimeout(() => void navigate('/', { replace: true }), 2000);
    } finally {
      setIsSelectingBucket(false);
      selectingRef.current = false;
    }
  }, [selectBucket, navigate]);

  useEffect(() => {
    // If URL bucket doesn't match context bucket, try to select it
    if (isConnected && bucket && bucket !== credentials?.bucket && !selectingRef.current) {
      void doSelectBucket(bucket);
    }
  }, [isConnected, bucket, credentials?.bucket, doSelectBucket]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
    };
  }, []);

  // Show loading while selecting bucket
  if (isSelectingBucket) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
        }}
      >
        <CircularProgress />
        <Box>Connecting to bucket: {bucket}</Box>
      </Box>
    );
  }

  // Show error if bucket selection failed
  if (error) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 2,
        }}
      >
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  // Wait until bucket is selected
  if (!credentials?.bucket || credentials.bucket !== bucket) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <BrowserProvider initialPath={initialPath} buildUrl={buildUrl}>
      <S3Browser />
    </BrowserProvider>
  );
}
