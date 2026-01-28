import { useS3ClientContext } from '../contexts';
import { LoginForm } from '../components/LoginForm';
import { BucketSelector } from '../components/BucketSelector';

export function HomePage() {
  const { isConnected } = useS3ClientContext();

  if (!isConnected) {
    return <LoginForm />;
  }

  // Show bucket selector when connected (even if a bucket is already selected)
  // This allows users to change buckets by navigating to "/"
  return <BucketSelector />;
}
