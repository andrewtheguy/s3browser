import { useParams } from 'react-router';
import { BucketSelector } from '../components/BucketSelector';

export function SelectBucketPage() {
  const { connectionId } = useParams<{ connectionId: string }>();

  // AuthGuard already handles all the authentication and connection checks
  // Just pass the connectionId to the BucketSelector
  return <BucketSelector connectionId={parseInt(connectionId!, 10)} />;
}
