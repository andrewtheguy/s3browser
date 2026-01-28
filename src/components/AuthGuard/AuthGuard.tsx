import { type ReactNode } from 'react';
import { Navigate, useParams, useLocation } from 'react-router';
import { Box, CircularProgress } from '@mui/material';
import { useS3ClientContext } from '../../contexts';

interface AuthGuardProps {
  children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isConnected, isCheckingSession, credentials } = useS3ClientContext();
  const { bucket } = useParams<{ bucket: string }>();
  const location = useLocation();

  // Show loading state while checking session status
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

  // Session check complete and not connected - redirect to home with returnTo param
  if (!isConnected) {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/?returnTo=${returnTo}`} replace />;
  }

  // Connected but no bucket in context yet - need to select bucket
  if (!credentials?.bucket) {
    // If URL has a bucket, we need to select it first
    // The BrowsePage will handle selecting the bucket from URL
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

  // Check if URL bucket matches context bucket
  if (bucket && bucket !== credentials.bucket) {
    // Bucket mismatch - redirect to home to handle bucket switch
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
