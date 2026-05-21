import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { Spinner } from '@/components/ui/spinner';
import { useS3ClientContext } from '../../contexts';

export function CenteredLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}

interface AuthGuardProps {
  children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isConnected, isCheckingSession, credentials, activeConnectionId, activateConnection, isLoggedIn } = useS3ClientContext();
  const { connectionId: urlConnectionId, bucket } = useParams<{ connectionId: string; bucket?: string }>();
  const activatingRef = useRef(false);
  const [activationError, setActivationError] = useState(false);

  const connectionId = urlConnectionId ? parseInt(urlConnectionId, 10) : null;

  // Activate connection if URL connectionId differs from active
  useEffect(() => {
    if (
      isLoggedIn &&
      !isCheckingSession &&
      connectionId &&
      !isNaN(connectionId) &&
      connectionId !== activeConnectionId &&
      !activatingRef.current
    ) {
      activatingRef.current = true;
      activateConnection(connectionId, bucket)
        .catch((error) => {
          console.error('Failed to activate connection:', error);
          setActivationError(true);
        })
        .finally(() => {
          activatingRef.current = false;
        });
    }
  }, [isLoggedIn, isCheckingSession, connectionId, activeConnectionId, activateConnection, bucket]);

  // Show loading state while checking session status
  if (isCheckingSession) {
    return <CenteredLoader />;
  }

  // Not logged in at all - redirect to home
  if (!isLoggedIn) {
    return <Navigate to="/" replace />;
  }

  // Invalid or missing connection ID in URL
  if (!connectionId || isNaN(connectionId)) {
    return <Navigate to="/" replace />;
  }

  // Connection activation failed - redirect to home
  if (activationError) {
    return <Navigate to="/" replace />;
  }

  // Not connected yet - show loading spinner while activating
  if (!isConnected) {
    return <CenteredLoader />;
  }

  // Connection ID mismatch - activating is happening
  if (activeConnectionId !== connectionId) {
    return <CenteredLoader />;
  }

  // Connected but no bucket in context yet - need to select bucket (for browse pages only)
  if (bucket && !credentials?.bucket) {
    // The BrowsePage will handle selecting the bucket from URL
    return <CenteredLoader />;
  }

  // Check if URL bucket matches context bucket (for browse pages)
  if (bucket && bucket !== credentials?.bucket) {
    // Bucket mismatch - redirect to home to handle bucket switch
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
