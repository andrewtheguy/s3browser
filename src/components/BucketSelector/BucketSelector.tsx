import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LogOut, RefreshCw, ArrowLeftRight } from 'lucide-react';
import { BucketIcon } from '@/components/ui/bucket-icon';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useS3Client } from '../../hooks';
import { listBuckets } from '../../services/api';
import { buildBrowseUrl } from '../../utils/urlEncoding';
import type { BucketInfo } from '../../types';

interface BucketSelectorProps {
  connectionId: number;
}

export function BucketSelector({ connectionId }: BucketSelectorProps) {
  const navigate = useNavigate();
  const { selectBucket, disconnect, error: contextError } = useS3Client();
  const [buckets, setBuckets] = useState<BucketInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSelecting, setIsSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualBucket, setManualBucket] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);
  const didClearRegionCacheRef = useRef(false);

  useEffect(() => {
    didClearRegionCacheRef.current = false;
  }, [connectionId]);

  const fetchBuckets = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setAccessDenied(false);

    try {
      const shouldClearRegionCache = !didClearRegionCacheRef.current;
      if (shouldClearRegionCache) {
        didClearRegionCacheRef.current = true;
      }
      const bucketList = await listBuckets(connectionId, { clearRegionCache: shouldClearRegionCache });
      // Sort buckets alphabetically by name
      const sortedBuckets = [...bucketList].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      setBuckets(sortedBuckets);
      if (sortedBuckets.length === 0) {
        setShowManualInput(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list buckets';
      if (message.includes('Access denied') || message.includes('403')) {
        setAccessDenied(true);
        setShowManualInput(true);
      } else {
        setError(message);
      }
    } finally {
      setIsLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void fetchBuckets();
  }, [fetchBuckets]);

  const handleSelectBucket = (bucketName: string) => {
    setIsSelecting(true);
    setError(null);

    try {
      const success = selectBucket(bucketName);
      if (success) {
        // Navigate to the browse page for this bucket
        void navigate(buildBrowseUrl(connectionId, bucketName, ''));
      } else {
        setError('Failed to select bucket');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to select bucket';
      setError(message);
    } finally {
      setIsSelecting(false);
    }
  };

  const handleManualSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!manualBucket.trim()) return;
    handleSelectBucket(manualBucket.trim());
  };

  const displayError = error || contextError;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-[500px] w-full">
        <CardContent className="p-8">
          <div className="flex items-center justify-center mb-6">
            <BucketIcon className="h-10 w-10 mr-2 text-primary" />
            <h1 className="text-2xl font-bold">
              Select Bucket
            </h1>
          </div>

          <p className="text-sm text-muted-foreground text-center mb-6">
            Choose a bucket to browse or enter one manually
          </p>

          {displayError && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{displayError}</AlertDescription>
            </Alert>
          )}

          {accessDenied && (
            <Alert className="mb-4">
              <AlertDescription>
                You do not have permission to list buckets. Please enter a bucket name manually.
              </AlertDescription>
            </Alert>
          )}

          {isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="lg" />
            </div>
          ) : (
            <>
              {!showManualInput && buckets.length > 0 && (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-muted-foreground">
                      Available Buckets ({buckets.length})
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={fetchBuckets}
                      disabled={isSelecting}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  </div>
                  <ScrollArea className="h-[300px] rounded-md border mb-4">
                    <div className="divide-y">
                      {buckets.map((bucket) => (
                        <button
                          key={bucket.name}
                          onClick={() => handleSelectBucket(bucket.name)}
                          disabled={isSelecting}
                          className="w-full text-left px-4 py-3 hover:bg-muted transition-colors disabled:opacity-50"
                        >
                          <p className="font-medium">{bucket.name}</p>
                          {bucket.creationDate && (
                            <p className="text-xs text-muted-foreground">
                              Created: {new Date(bucket.creationDate).toLocaleDateString()}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                  <Button
                    variant="link"
                    onClick={() => setShowManualInput(true)}
                    className="mb-4"
                    disabled={isSelecting}
                  >
                    Enter bucket name manually
                  </Button>
                </>
              )}

              {(showManualInput || buckets.length === 0) && (
                <form onSubmit={handleManualSubmit}>
                  {buckets.length > 0 && (
                    <Button
                      variant="link"
                      onClick={() => setShowManualInput(false)}
                      className="mb-4"
                      disabled={isSelecting}
                      type="button"
                    >
                      Back to bucket list
                    </Button>
                  )}
                  <Input
                    placeholder="my-bucket-name"
                    value={manualBucket}
                    onChange={(e) => setManualBucket(e.target.value)}
                    required
                    autoComplete="off"
                    disabled={isSelecting}
                    className="mb-4"
                  />
                  <Button
                    type="submit"
                    className="w-full"
                    size="lg"
                    disabled={!manualBucket.trim() || isSelecting}
                  >
                    {isSelecting ? (
                      <Spinner size="sm" className="text-white" />
                    ) : (
                      'Connect to Bucket'
                    )}
                  </Button>
                </form>
              )}

              {isSelecting && !showManualInput && (
                <div className="flex justify-center py-4">
                  <Spinner size="md" />
                </div>
              )}
            </>
          )}

          <Separator className="my-6" />

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => void navigate('/')}
              disabled={isSelecting}
            >
              <ArrowLeftRight className="h-4 w-4 mr-2" />
              Change Connection
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={async () => {
                try {
                  await disconnect();
                } catch (err) {
                  console.error('Failed to disconnect:', err);
                }
                void navigate('/');
              }}
              disabled={isSelecting}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
