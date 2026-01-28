import { useS3ClientContext } from '../contexts';
import { LoginForm } from '../components/LoginForm';
import { BucketSelector } from '../components/BucketSelector';

export function HomePage() {
  const { isConnected } = useS3ClientContext();

  if (!isConnected) {
    return <LoginForm />;
  }

  // Show bucket selector when connected
  // LoginForm handles redirect to browse page if bucket was provided at login
  return <BucketSelector />;
}
