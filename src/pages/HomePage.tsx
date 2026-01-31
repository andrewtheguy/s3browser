import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { LoginForm } from '../components/LoginForm';

export function HomePage() {
  const navigate = useNavigate();
  const { isConnected, credentials, isCheckingSession } = useS3ClientContext();

  useEffect(() => {
    // If connected with a bucket selected, redirect to browse
    if (!isCheckingSession && isConnected && credentials?.bucket) {
      void navigate(`/browse/${encodeURIComponent(credentials.bucket)}`, { replace: true });
    }
  }, [isConnected, credentials?.bucket, isCheckingSession, navigate]);

  useEffect(() => {
    // If connected but no bucket, redirect to bucket selection
    if (!isCheckingSession && isConnected && !credentials?.bucket) {
      void navigate('/select-bucket', { replace: true });
    }
  }, [isConnected, credentials?.bucket, isCheckingSession, navigate]);

  // Show LoginForm when not connected
  // Will handle redirection above if already connected
  return <LoginForm />;
}
