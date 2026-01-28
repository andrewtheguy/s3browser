import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useS3ClientContext } from '../contexts';
import { LoginForm } from '../components/LoginForm';
import { BucketSelector } from '../components/BucketSelector';
import { buildBrowseUrl } from '../utils/urlEncoding';

export function HomePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isConnected, requiresBucketSelection, credentials } = useS3ClientContext();

  useEffect(() => {
    // If fully connected (has bucket), redirect to browse page
    if (isConnected && credentials?.bucket) {
      const returnTo = searchParams.get('returnTo');
      if (returnTo) {
        // Validate returnTo starts with /browse/ to prevent open redirect
        if (returnTo.startsWith('/browse/')) {
          void navigate(returnTo, { replace: true });
          return;
        }
      }
      // Default: go to bucket root
      void navigate(buildBrowseUrl(credentials.bucket, ''), { replace: true });
    }
  }, [isConnected, credentials?.bucket, navigate, searchParams]);

  if (!isConnected) {
    return <LoginForm />;
  }

  if (requiresBucketSelection) {
    return <BucketSelector />;
  }

  // Will redirect in useEffect, show nothing while redirecting
  return null;
}
