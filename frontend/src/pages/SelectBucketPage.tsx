import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, ChevronRight, Pin, RefreshCw, Search } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { BucketIcon, CloudBucketIcon, EndpointIcon } from '@/components/icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { CenteredLoader } from '../components/CenteredLoader';
import { describeEndpoint } from '../components/ConnectionCard';
import { EmptyState } from '../components/EmptyState';
import { PageContainer } from '../components/PageContainer';
import { useConnectionRoute } from '../hooks/useConnectionRoute';
import { refreshBuckets, useBucketsQuery, useValidateBucketMutation } from '../queries/buckets';
import { useConnectionQuery } from '../queries/connections';
import { ApiHttpError } from '../services/api/client';
import { formatRelativeTime } from '../utils/relativeTime';
import { CONNECTIONS_URL, buildBrowseUrl, buildConnectionEditUrl } from '../utils/urlEncoding';

// The ::before bar is the orange rule shown on hover/focus.
const rowClass =
  'relative flex min-h-12 items-center gap-3 px-3 py-2 text-left transition-colors before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-transparent hover:bg-accent/60 hover:before:bg-primary focus-visible:bg-accent/60 focus-visible:outline-none focus-visible:before:bg-primary';
const listClass = 'divide-y overflow-hidden rounded-xl border bg-card shadow-xs';
const sectionLabelClass = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const linkClass = 'font-medium text-primary-ink underline-offset-4 hover:underline';

interface BucketRowProps {
  connectionId: number;
  name: string;
  trailing?: string;
  pinned?: boolean;
}

function BucketRow({ connectionId, name, trailing, pinned = false }: BucketRowProps) {
  return (
    <li>
      <Link to={buildBrowseUrl(connectionId, name, '')} className={rowClass}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary-ink">
          <BucketIcon className="h-4.5 w-4.5" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {pinned && (
          <Badge variant="outline" className="shrink-0 gap-1 border-primary/40 bg-primary/10 font-medium text-primary-ink">
            <Pin className="h-3 w-3" />
            default
          </Badge>
        )}
        {trailing && <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{trailing}</span>}
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function SelectBucketPage() {
  const connectionId = useConnectionRoute();
  const navigate = useNavigate();
  const { data: connection } = useConnectionQuery(connectionId);
  const bucketsQuery = useBucketsQuery(connectionId);
  const validate = useValidateBucketMutation(connectionId);
  const [filter, setFilter] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    document.title = `${connection?.profileName ?? 'Buckets'} - s3browser`;
  }, [connection?.profileName]);

  if (!connection) {
    return <CenteredLoader />;
  }

  const accessDenied =
    bucketsQuery.isError && bucketsQuery.error instanceof ApiHttpError && bucketsQuery.error.status === 403;
  const listEmpty = bucketsQuery.isSuccess && bucketsQuery.data.length === 0;
  const showManual = manualOpen || accessDenied || listEmpty;

  const recents = connection.recentBuckets.filter((r) => r.name !== connection.bucket);
  const hasRecentSection = Boolean(connection.bucket) || recents.length > 0;

  const buckets = bucketsQuery.data ?? [];
  const needle = filter.trim().toLowerCase();
  const filteredBuckets = needle ? buckets.filter((b) => b.name.toLowerCase().includes(needle)) : buckets;

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshBuckets(connectionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to refresh buckets');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleManualSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const name = manualName.trim();
    if (!name) return;
    try {
      await validate.mutateAsync(name);
      void navigate(buildBrowseUrl(connectionId, name, ''));
    } catch {
      // validate.error is rendered inline.
    }
  };

  return (
    <PageContainer className="max-w-2xl">
      <div className="mb-6 flex items-start gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-brand to-brand-2 text-brand-foreground shadow-xs">
          {connection.endpoint ? <EndpointIcon className="h-6 w-6" /> : <CloudBucketIcon className="h-6 w-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{connection.profileName}</h1>
          <p className="mt-0.5 truncate font-mono text-[13px] text-muted-foreground">{describeEndpoint(connection)}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link to={buildConnectionEditUrl(connectionId)} className={linkClass}>
              Edit connection
            </Link>
            <Link to={CONNECTIONS_URL} className={linkClass}>
              Change connection
            </Link>
          </div>
        </div>
      </div>

      {hasRecentSection && (
        <section className="mb-6">
          <h2 className={`mb-2 ${sectionLabelClass}`}>Recent</h2>
          <ul className={listClass}>
            {connection.bucket && <BucketRow connectionId={connectionId} name={connection.bucket} pinned />}
            {recents.map((recent) => (
              <BucketRow
                connectionId={connectionId}
                key={recent.name}
                name={recent.name}
                trailing={formatRelativeTime(recent.lastUsedAt)}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className={sectionLabelClass}>
            All buckets
            {bucketsQuery.isSuccess && buckets.length > 0 && (
              <span className="font-normal tabular-nums">
                {' '}
                ({needle ? `${filteredBuckets.length} of ${buckets.length}` : buckets.length})
              </span>
            )}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing || bucketsQuery.isPending}
            aria-label="Refresh bucket list"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {bucketsQuery.isPending ? (
          <ul className={listClass} aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex min-h-12 items-center gap-3 px-3">
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-4 w-48" />
              </li>
            ))}
          </ul>
        ) : accessDenied ? (
          <Alert variant="warning">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Cannot list buckets</AlertTitle>
            <AlertDescription>These keys may not list buckets. Open one by name below.</AlertDescription>
          </Alert>
        ) : bucketsQuery.isError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Could not list buckets</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{bucketsQuery.error.message}</span>
              <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={isRefreshing}>
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : listEmpty ? (
          <EmptyState
            className="py-8"
            icon={<BucketIcon />}
            title="No buckets yet"
            description="No buckets are visible to these keys."
          />
        ) : (
          <>
            {buckets.length > 5 && (
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter buckets…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  className="h-11 pl-9"
                  aria-label="Filter buckets"
                />
              </div>
            )}
            {filteredBuckets.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No buckets match "{filter.trim()}".</p>
            ) : (
              <ul className={listClass}>
                {filteredBuckets.map((bucket) => (
                  <BucketRow
                    connectionId={connectionId}
                    key={bucket.name}
                    name={bucket.name}
                    trailing={bucket.creationDate ? new Date(bucket.creationDate).toLocaleDateString() : undefined}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section>
        {showManual ? (
          <form onSubmit={(event) => void handleManualSubmit(event)} className="space-y-2">
            <h2 className={sectionLabelClass}>Open a bucket by name</h2>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="my-bucket-name"
                value={manualName}
                onChange={(event) => {
                  validate.reset();
                  setManualName(event.target.value);
                }}
                required
                autoComplete="off"
                className="h-11 flex-1 font-mono"
                aria-label="Bucket name"
              />
              <Button type="submit" className="h-11" disabled={!manualName.trim() || validate.isPending}>
                {validate.isPending ? <Spinner size="sm" className="text-primary-foreground" /> : 'Open'}
              </Button>
            </div>
            {validate.isError && <p className="text-sm text-destructive">{validate.error.message}</p>}
          </form>
        ) : (
          <Button variant="link" className="h-11 px-0" onClick={() => setManualOpen(true)}>
            Open a bucket by name…
          </Button>
        )}
      </section>
    </PageContainer>
  );
}
