import { useEffect, useState, useRef, useCallback } from 'react';
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

  // Decode the URL path to S3 path
  const initialPath = decodeUrlToS3Path(splatPath || '');

  const doSelectBucket = useCallback(async (bucketName: string) => {
    if (selectingRef.current) return;
    selectingRef.current = true;
    setIsSelectingBucket(true);
    setError(null);

    try {
      const success = await selectBucket(bucketName);
      if (!success) {
        setError(`Failed to access bucket: ${bucketName}`);
        setTimeout(() => void navigate('/', { replace: true }), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select bucket');
      setTimeout(() => void navigate('/', { replace: true }), 2000);
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
    <BrowserProvider
      initialPath={initialPath}
      bucket={bucket}
      buildUrl={(path: string) => buildBrowseUrl(bucket, path)}
    >
      <S3Browser />
    </BrowserProvider>
  );
}
