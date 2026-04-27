import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useMatch } from 'react-router';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { BrowserProvider, useS3ClientContext } from '../contexts';
import { S3Browser } from '../components/S3Browser';
import { decodeUrlToS3Path, buildBrowseUrl } from '../utils/urlEncoding';

export function BrowsePage() {
  const { connectionId: urlConnectionId, bucket, '*': splatPath } = useParams<{ connectionId: string; bucket: string; '*': string }>();
  const previewMatch = useMatch('/connection/:connectionId/preview/:bucket/*');
  const isPreviewMode = previewMatch !== null;
  const { isConnected, credentials, selectBucket, activeConnectionId } = useS3ClientContext();
  const navigate = useNavigate();
  const [isSelectingBucket, setIsSelectingBucket] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectingRef = useRef(false);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parsedConnectionId = urlConnectionId ? parseInt(urlConnectionId, 10) : NaN;
  const connectionId = !isNaN(parsedConnectionId) && parsedConnectionId > 0 ? parsedConnectionId : null;

  // In preview mode the splat is the file's full key (no trailing slash). The folder
  // listing the user is browsing is its parent prefix.
  // In browse mode the splat is the folder prefix itself.
  const previewKey = useMemo(() => {
    if (!isPreviewMode || !splatPath) return null;
    return decodeUrlToS3Path(splatPath, false);
  }, [isPreviewMode, splatPath]);

  const currentPath = useMemo(() => {
    if (isPreviewMode) {
      if (!splatPath) return '';
      const decoded = decodeUrlToS3Path(splatPath, false);
      const segments = decoded.split('/').filter(Boolean);
      segments.pop();
      return segments.length > 0 ? segments.join('/') + '/' : '';
    }
    return decodeUrlToS3Path(splatPath || '', true);
  }, [isPreviewMode, splatPath]);

  useEffect(() => {
    if (!bucket) return;
    if (isPreviewMode && previewKey) {
      const fileName = previewKey.split('/').pop() || previewKey;
      document.title = `${fileName} - ${bucket} - s3browser`;
    } else if (currentPath) {
      document.title = `${bucket}/${currentPath} - s3browser`;
    } else {
      document.title = `${bucket} - s3browser`;
    }
  }, [bucket, currentPath, isPreviewMode, previewKey]);

  // Memoize buildUrl to prevent unnecessary re-renders in BrowserProvider
  const buildUrl = useCallback(
    (path: string) => (connectionId && bucket ? buildBrowseUrl(connectionId, bucket, path) : '/'),
    [connectionId, bucket]
  );

  const doSelectBucket = useCallback((bucketName: string) => {
    if (selectingRef.current) return;
    selectingRef.current = true;
    setIsSelectingBucket(true);
    setError(null);

    // Clear any pending timeout from previous attempts
    if (timeoutIdRef.current) {
      clearTimeout(timeoutIdRef.current);
      timeoutIdRef.current = null;
    }

    try {
      const success = selectBucket(bucketName);
      if (!success) {
        setError(`Failed to access bucket: ${bucketName}`);
        timeoutIdRef.current = setTimeout(() => void navigate('/', { replace: true }), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select bucket');
      timeoutIdRef.current = setTimeout(() => void navigate('/', { replace: true }), 2000);
    } finally {
      setIsSelectingBucket(false);
      selectingRef.current = false;
    }
  }, [selectBucket, navigate]);

  useEffect(() => {
    // If URL bucket doesn't match context bucket, try to select it
    if (isConnected && bucket && bucket !== credentials?.bucket && !selectingRef.current) {
      void doSelectBucket(bucket);
    }
  }, [isConnected, bucket, credentials?.bucket, doSelectBucket]);

  // Redirect if connection ID or bucket is invalid
  useEffect(() => {
    if (!connectionId || !bucket) {
      console.error('Invalid URL: missing or invalid connection ID or bucket');
      void navigate('/', { replace: true });
    }
  }, [connectionId, bucket, navigate]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
    };
  }, []);

  // Show loading while selecting bucket
  if (isSelectingBucket) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <Spinner size="lg" />
        <div>Connecting to bucket: {bucket}</div>
      </div>
    );
  }

  // Show error if bucket selection failed
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Wait until bucket is selected and connection ID matches
  if (!credentials?.bucket || credentials.bucket !== bucket || activeConnectionId !== connectionId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <BrowserProvider currentPath={currentPath} buildUrl={buildUrl}>
      <S3Browser previewKey={previewKey} />
    </BrowserProvider>
  );
}
