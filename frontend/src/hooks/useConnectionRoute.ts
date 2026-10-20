import { useParams } from 'react-router';
import { parseConnectionId } from '../utils/urlEncoding';

/** The connection id named in the URL; only valid under `/connection/:connectionId`. */
export function useConnectionRoute(): number {
  const { connectionId } = useParams<{ connectionId: string }>();
  const parsed = parseConnectionId(connectionId);
  if (parsed === null) {
    throw new Error('useConnectionRoute must be used under a connection route');
  }
  return parsed;
}
