import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, Search, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useS3ClientContext } from '../contexts';
import { buildBrowseUrl, buildPreviewUrl } from '../utils/urlEncoding';
import { formatDate, formatFileSize } from '../utils/formatters';
import {
  searchObjects,
  getIndexStatus,
  type SearchObjectsResponse,
  type IndexStatusResponse,
  type SearchSortKey,
  type SearchSortDir,
} from '../services/api/objects';
import { cn } from '@/lib/utils';
import { ApiHttpError } from '../services/api/client';
import { HighlightedText } from '../components/HighlightedText';
import type { S3Object } from '../types';

const PAGE_SIZE = 100;

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const elapsedSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (elapsedSec < 60) return `${elapsedSec}s ago`;
  if (elapsedSec < 3600) return `${Math.floor(elapsedSec / 60)}m ago`;
  if (elapsedSec < 86_400) return `${Math.floor(elapsedSec / 3600)}h ago`;
  return `${Math.floor(elapsedSec / 86_400)}d ago`;
}

export function SearchPage() {
  const { connectionId: urlConnectionId, bucket } = useParams<{
    connectionId: string;
    bucket: string;
  }>();
  const { isConnected, credentials, selectBucket, activeConnectionId, activeSearchEnabled } = useS3ClientContext();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const parsedConnectionId = urlConnectionId ? parseInt(urlConnectionId, 10) : NaN;
  const connectionId = !Number.isNaN(parsedConnectionId) && parsedConnectionId > 0 ? parsedConnectionId : null;

  const [selectingBucket, setSelectingBucket] = useState(false);
  const [bucketError, setBucketError] = useState<string | null>(null);
  const selectingRef = useRef(false);

  // Bucket selection mirrors BrowsePage so AuthGuard releases us with a matching bucket.
  const doSelectBucket = useCallback((bucketName: string) => {
    if (selectingRef.current) return;
    selectingRef.current = true;
    setSelectingBucket(true);
    setBucketError(null);
    try {
      const success = selectBucket(bucketName);
      if (!success) {
        setBucketError(`Failed to access bucket: ${bucketName}`);
        setTimeout(() => void navigate('/', { replace: true }), 2000);
      }
    } catch (err) {
      setBucketError(err instanceof Error ? err.message : 'Failed to select bucket');
      setTimeout(() => void navigate('/', { replace: true }), 2000);
    } finally {
      setSelectingBucket(false);
      selectingRef.current = false;
    }
  }, [selectBucket, navigate]);

  useEffect(() => {
    if (isConnected && bucket && bucket !== credentials?.bucket && !selectingRef.current) {
      doSelectBucket(bucket);
    }
  }, [isConnected, bucket, credentials?.bucket, doSelectBucket]);

  useEffect(() => {
    if (!connectionId || !bucket) {
      void navigate('/', { replace: true });
    }
  }, [connectionId, bucket, navigate]);

  useEffect(() => {
    if (bucket) {
      document.title = `Search ${bucket} - s3browser`;
    }
  }, [bucket]);

  const queryFromUrl = searchParams.get('q') ?? '';
  const prefixFromUrl = searchParams.get('prefix') ?? '';
  const [inputValue, setInputValue] = useState(queryFromUrl);

  // Keep the input in sync if the URL changes externally (back/forward).
  useEffect(() => {
    setInputValue(queryFromUrl);
  }, [queryFromUrl]);

  // Index status — fetched once when the bucket is ready.
  const [indexStatus, setIndexStatus] = useState<IndexStatusResponse | null>(null);
  useEffect(() => {
    if (!connectionId || !bucket || credentials?.bucket !== bucket) return;
    if (!activeSearchEnabled) return;
    const controller = new AbortController();
    getIndexStatus(connectionId, bucket, controller.signal)
      .then(setIndexStatus)
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('Failed to load index status', err);
      });
    return () => controller.abort();
  }, [connectionId, bucket, credentials?.bucket, activeSearchEnabled]);

  // Search state
  const [results, setResults] = useState<S3Object[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [indexMissing, setIndexMissing] = useState(false);
  const sortKey: SearchSortKey = searchParams.get('sort') === 'last_modified' ? 'last_modified' : 'key';
  const sortDir: SearchSortDir = searchParams.get('dir') === 'desc' ? 'desc' : 'asc';

  const toggleSort = useCallback((key: SearchSortKey) => {
    setOffset(0);
    const next = new URLSearchParams(searchParams);
    if (sortKey === key) {
      next.set('dir', sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      next.set('sort', key);
      next.set('dir', key === 'last_modified' ? 'desc' : 'asc');
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, sortKey, sortDir]);

  // Run a search whenever the URL query, pagination offset, or sort changes.
  useEffect(() => {
    if (!connectionId || !bucket || credentials?.bucket !== bucket) return;
    if (!activeSearchEnabled) return;
    if (!queryFromUrl.trim()) {
      setResults([]);
      setTotal(0);
      setSearchError(null);
      setIndexMissing(false);
      return;
    }

    const controller = new AbortController();
    setIsSearching(true);
    setSearchError(null);
    setIndexMissing(false);

    searchObjects(connectionId, bucket, queryFromUrl, {
      limit: PAGE_SIZE,
      offset,
      sort: sortKey,
      dir: sortDir,
      prefix: prefixFromUrl,
      signal: controller.signal,
    })
      .then((response: SearchObjectsResponse) => {
        if (controller.signal.aborted) return;
        setResults(response.objects);
        setTotal(response.total);
        setIndexStatus({
          lastIndexedAt: response.lastIndexedAt,
          objectCount: response.objectCount,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiHttpError && err.code === 'IndexNotBuilt') {
          setIndexMissing(true);
          setResults([]);
          setTotal(0);
        } else {
          setSearchError(err instanceof Error ? err.message : 'Search failed');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsSearching(false);
      });

    return () => controller.abort();
  }, [connectionId, bucket, credentials?.bucket, queryFromUrl, prefixFromUrl, offset, sortKey, sortDir, activeSearchEnabled]);

  // Reset to page 1 whenever the prefix scope changes so we don't strand
  // the user on a now-out-of-range page.
  useEffect(() => {
    setOffset(0);
  }, [prefixFromUrl]);

  const clearPrefix = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('prefix');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const submitSearch = useCallback((value: string) => {
    const trimmed = value.trim();
    setOffset(0);
    const next = new URLSearchParams(searchParams);
    if (trimmed) {
      next.set('q', trimmed);
    } else {
      next.delete('q');
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  if (selectingBucket) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <Spinner size="lg" />
        <div>Connecting to bucket: {bucket}</div>
      </div>
    );
  }

  if (bucketError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{bucketError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (
    connectionId === null ||
    !bucket ||
    !credentials?.bucket ||
    credentials.bucket !== bucket ||
    activeConnectionId !== connectionId
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  const indexCommand = `bun run index -- --connection ${connectionId} --bucket ${bucket}`;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      <div className="mb-4 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold flex flex-wrap items-center gap-2">
            <span>
              Search <span className="text-muted-foreground">in {bucket}</span>
            </span>
            {prefixFromUrl && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-sm font-mono font-semibold text-primary">
                <span className="text-primary/70">scope:</span>
                <span className="break-all">{prefixFromUrl}</span>
                <button
                  type="button"
                  onClick={clearPrefix}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
                  aria-label="Clear prefix scope"
                  title="Clear prefix scope"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </h1>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigate(buildBrowseUrl(connectionId, bucket, prefixFromUrl))}
          >
            Back to browse
          </Button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch(inputValue);
          }}
          className="flex items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Search object keys (substring match)"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="pl-8"
              disabled={!activeSearchEnabled}
            />
          </div>
          <Button type="submit" disabled={!activeSearchEnabled}>Search</Button>
        </form>

        {activeSearchEnabled && (
          <div className="text-xs text-muted-foreground">
            {indexStatus?.lastIndexedAt ? (
              <>
                Index: {indexStatus.objectCount?.toLocaleString() ?? '?'} keys · updated {formatRelative(indexStatus.lastIndexedAt)}
              </>
            ) : (
              <>Index not built yet for this bucket.</>
            )}
          </div>
        )}
      </div>

      {!activeSearchEnabled && (
        <Alert className="mb-3">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Search is disabled for this connection because its S3 endpoint host is not in
            <span className="mx-1 font-mono">S3BROWSER_SEARCH_WHITELIST_HOSTS</span>.
            Add the host to that comma-separated env var and restart the server to enable search.
          </AlertDescription>
        </Alert>
      )}

      {indexMissing && (
        <Alert className="mb-3">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            No index exists for this bucket yet. Build one by running:
            <pre className="mt-2 rounded bg-muted px-2 py-1 font-mono text-xs">{indexCommand}</pre>
          </AlertDescription>
        </Alert>
      )}

      {searchError && (
        <Alert variant="destructive" className="mb-3">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{searchError}</AlertDescription>
        </Alert>
      )}

      {!activeSearchEnabled ? null : !queryFromUrl.trim() ? (
        <div className="py-16 text-center text-muted-foreground">
          Type a query to search indexed keys.
        </div>
      ) : isSearching && results.length === 0 ? (
        <div className="py-16 flex justify-center">
          <Spinner size="lg" />
        </div>
      ) : results.length === 0 && !indexMissing && !searchError ? (
        <div className="py-16 text-center text-muted-foreground">
          No matches for <span className="font-mono">{queryFromUrl}</span>.
        </div>
      ) : (
        <>
          <div className="mb-2 text-sm text-muted-foreground">
            {total.toLocaleString()} match{total === 1 ? '' : 'es'}
            {totalPages > 1 ? ` · page ${currentPage} of ${totalPages}` : ''}
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <button
                      type="button"
                      onClick={() => toggleSort('key')}
                      className={cn(
                        'inline-flex items-center gap-1 hover:text-foreground',
                        sortKey === 'key' ? 'text-foreground' : 'text-muted-foreground'
                      )}
                    >
                      <span>Key</span>
                      {sortKey === 'key' ? (
                        sortDir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />
                      ) : (
                        <ArrowUpDown className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </TableHead>
                  <TableHead>Snippet</TableHead>
                  <TableHead className="w-[100px]">Size</TableHead>
                  <TableHead className="w-[180px]">
                    <button
                      type="button"
                      onClick={() => toggleSort('last_modified')}
                      className={cn(
                        'inline-flex items-center gap-1 hover:text-foreground',
                        sortKey === 'last_modified' ? 'text-foreground' : 'text-muted-foreground'
                      )}
                    >
                      <span>Last Modified</span>
                      {sortKey === 'last_modified' ? (
                        sortDir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />
                      ) : (
                        <ArrowUpDown className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((item) => {
                  const href = item.isFolder
                    ? buildBrowseUrl(connectionId, bucket, item.key)
                    : buildPreviewUrl(connectionId, bucket, item.key);
                  return (
                    <TableRow key={item.key}>
                      <TableCell className="font-mono text-xs">
                        <a
                          href={href}
                          onClick={(e) => {
                            e.preventDefault();
                            void navigate(href);
                          }}
                          className="hover:underline break-all"
                        >
                          <HighlightedText text={item.key} query={queryFromUrl} />
                        </a>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground break-all">
                        {item.contentSnippet ? (
                          <>
                            …<HighlightedText text={item.contentSnippet} query={queryFromUrl} />…
                            {item.contentMatchCount ? (
                              <span className="ml-2 whitespace-nowrap text-[11px] opacity-70">
                                ({item.contentMatchCount} match{item.contentMatchCount === 1 ? '' : 'es'})
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </TableCell>
                      <TableCell>{item.isFolder ? '-' : formatFileSize(item.size)}</TableCell>
                      <TableCell>{formatDate(item.lastModified)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0 || isSearching}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total || isSearching}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
