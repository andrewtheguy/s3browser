import { type ReactNode, useEffect, useRef } from 'react';
import { Navigate, useParams } from 'react-router';
import { Box, CircularProgress } from '@mui/material';
import { useS3ClientContext } from '../../contexts';

interface AuthGuardProps {
  children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isConnected, isCheckingSession, credentials, activeConnectionId, activateConnection, isUserLoggedIn } = useS3ClientContext();
  const { connectionId: urlConnectionId, bucket } = useParams<{ connectionId: string; bucket?: string }>();
  const activatingRef = useRef(false);

  const connectionId = urlConnectionId ? parseInt(urlConnectionId, 10) : null;

  // Activate connection if URL connectionId differs from active
  useEffect(() => {
    if (
      isUserLoggedIn &&
      !isCheckingSession &&
      connectionId &&
      !isNaN(connectionId) &&
      connectionId !== activeConnectionId &&
      !activatingRef.current
    ) {
      activatingRef.current = true;
      void activateConnection(connectionId, bucket).finally(() => {
        activatingRef.current = false;
      });
    }
  }, [isUserLoggedIn, isCheckingSession, connectionId, activeConnectionId, activateConnection, bucket]);

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

  // Not logged in at all - redirect to home
  if (!isUserLoggedIn) {
    return <Navigate to="/" replace />;
  }

  // Invalid or missing connection ID in URL
  if (!connectionId || isNaN(connectionId)) {
    return <Navigate to="/" replace />;
  }

  // Session check complete and not connected - redirect to home
  if (!isConnected) {
    // Still activating connection
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

  // Connection ID mismatch - activating is happening
  if (activeConnectionId !== connectionId) {
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

  // Connected but no bucket in context yet - need to select bucket (for browse pages only)
  if (bucket && !credentials?.bucket) {
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

  // Check if URL bucket matches context bucket (for browse pages)
  if (bucket && bucket !== credentials?.bucket) {
    // Bucket mismatch - redirect to home to handle bucket switch
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
