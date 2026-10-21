import { useEffect, useState } from 'react';
import { AlertCircle, Plus, RefreshCw, Search } from 'lucide-react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { BucketIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ConnectionCard } from '../components/ConnectionCard';
import { EmptyState } from '../components/EmptyState';
import { PageContainer } from '../components/PageContainer';
import { useConnectionsQuery } from '../queries/connections';
import { CONNECTION_NEW_URL } from '../utils/urlEncoding';

function matchesFilter(filter: string, connection: { profileName: string; endpoint: string }): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return (
    connection.profileName.toLowerCase().includes(needle) ||
    connection.endpoint.toLowerCase().includes(needle) ||
    (!connection.endpoint && 'aws'.includes(needle))
  );
}

export function ConnectionsPage() {
  const query = useConnectionsQuery();
  const [filter, setFilter] = useState('');

  useEffect(() => {
    document.title = 'Connections - s3browser';
  }, []);

  const connections = query.data ?? [];
  const filtered = connections.filter((connection) => matchesFilter(filter, connection));

  return (
    <PageContainer>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <Button asChild className="h-11 w-full sm:w-auto">
          <Link to={CONNECTION_NEW_URL}>
            <Plus className="h-4 w-4" />
            New connection
          </Link>
        </Button>
      </div>

      {connections.length >= 2 && (
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by name or endpoint…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="h-11 pl-9"
            aria-label="Filter connections"
          />
        </div>
      )}

      {query.isPending ? (
        <ul className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3 rounded-xl border bg-card p-4">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div>
                <Skeleton className="mb-2 h-5 w-40" />
                <Skeleton className="h-3.5 w-64 max-w-[50vw]" />
              </div>
            </li>
          ))}
        </ul>
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not load connections</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{query.error.message}</span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : connections.length === 0 ? (
        <EmptyState
          icon={<BucketIcon />}
          title="No connections yet"
          description="Add an AWS account or any S3-compatible endpoint. Credentials are encrypted and stored on this server."
        >
          <Button asChild className="h-11">
            <Link to={CONNECTION_NEW_URL}>
              <Plus className="h-4 w-4" />
              New connection
            </Link>
          </Button>
        </EmptyState>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No connections match "{filter.trim()}".</p>
      ) : (
        <ul className="space-y-3">
          {filtered.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} />
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
