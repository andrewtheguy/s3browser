import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { BucketSelector } from '../components/BucketSelector';

export function SelectBucketPage() {
  const { connectionId: urlConnectionId } = useParams<{ connectionId: string }>();
  const navigate = useNavigate();

  const parsedId = urlConnectionId ? parseInt(urlConnectionId, 10) : NaN;
  const connectionId = !isNaN(parsedId) && parsedId > 0 ? parsedId : null;

  useEffect(() => {
    if (!connectionId) {
      console.error('Invalid URL: missing or invalid connection ID');
      void navigate('/', { replace: true });
    }
  }, [connectionId, navigate]);

  if (!connectionId) {
    return null;
  }

  return <BucketSelector connectionId={connectionId} />;
}
