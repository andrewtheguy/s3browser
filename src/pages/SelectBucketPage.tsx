import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { Box, CircularProgress } from '@mui/material';
import { useS3ClientContext } from '../contexts';
import { BucketSelector } from '../components/BucketSelector';

export function SelectBucketPage() {
  const navigate = useNavigate();
  const { isConnected, isCheckingSession, credentials } = useS3ClientContext();

  useEffect(() => {
    // Redirect to home if not connected (S3 credentials not set)
    if (!isCheckingSession && !isConnected) {
      void navigate('/', { replace: true });
    }
  }, [isConnected, isCheckingSession, navigate]);

  useEffect(() => {
    // If already has a bucket selected, redirect to browse
    if (isConnected && credentials?.bucket) {
      void navigate(`/browse/${encodeURIComponent(credentials.bucket)}`, { replace: true });
    }
  }, [isConnected, credentials?.bucket, navigate]);

  // Show loading while checking session
  if (isCheckingSession) {
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

  // Don't render if not connected (will redirect)
  if (!isConnected) {
    return null;
  }

  // Don't render if bucket already selected (will redirect)
  if (credentials?.bucket) {
    return null;
  }

  return <BucketSelector />;
}
