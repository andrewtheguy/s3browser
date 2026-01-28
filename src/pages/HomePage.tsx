import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { LoginForm } from '../components/LoginForm';
import { BucketSelector } from '../components/BucketSelector';

export function HomePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isConnected, credentials } = useS3ClientContext();

  const returnTo = searchParams.get('returnTo');

  useEffect(() => {
    // Only auto-redirect if there's a returnTo param (user was redirected from a protected route)
    // This allows users to explicitly navigate to "/" to change buckets
    if (isConnected && credentials?.bucket && returnTo) {
      // Validate returnTo starts with /browse/ to prevent open redirect
      if (returnTo.startsWith('/browse/')) {
        void navigate(returnTo, { replace: true });
      }
    }
  }, [isConnected, credentials?.bucket, navigate, returnTo]);

  if (!isConnected) {
    return <LoginForm />;
  }

  // Show bucket selector when connected (even if a bucket is already selected)
  // This allows users to change buckets by navigating to "/"
  return <BucketSelector />;
}
