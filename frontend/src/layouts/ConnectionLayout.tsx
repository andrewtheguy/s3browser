import { AlertCircle, RefreshCw } from 'lucide-react';
import { Outlet, useParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CenteredLoader } from '../components/CenteredLoader';
import { PageContainer } from '../components/PageContainer';
import { RedirectHome } from '../components/RedirectHome';
import { useConnectionQuery } from '../queries/connections';
import { ApiHttpError } from '../services/api/client';
import { parseConnectionId } from '../utils/urlEncoding';

/**
 * Layout route under `/connection/:connectionId`: loads the connection once so
 * every page below can read it from the cache, and handles bad links.
 */
export function ConnectionLayout() {
  const { connectionId: raw } = useParams<{ connectionId: string }>();
  const connectionId = parseConnectionId(raw);
  const query = useConnectionQuery(connectionId);

  if (connectionId === null) {
    return <RedirectHome reason="That connection link is not valid." />;
  }
  if (query.isError && query.error instanceof ApiHttpError && query.error.status === 404) {
    return <RedirectHome reason="Connection not found." />;
  }
  if (query.isError && !query.data) {
    return (
      <PageContainer>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not load this connection</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{query.error.message}</span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </PageContainer>
    );
  }
  if (!query.data) {
    return <CenteredLoader />;
  }
  return <Outlet />;
}
