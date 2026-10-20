import { useCallback, useEffect, useMemo } from 'react';
import { useMatch, useParams } from 'react-router';
import { BrowserProvider } from '../contexts';
import { S3Browser } from '../components/S3Browser';
import { useBucketRoute } from '../hooks/useBucketRoute';
import { buildBrowseUrl, decodeUrlToS3Path } from '../utils/urlEncoding';

/** `/connection/:id/browse/:bucket/*` lists a folder; `/preview/:bucket/*` shows one object inside its folder. */
export function BrowsePage() {
  const { connectionId, bucket } = useBucketRoute();
  const { '*': splatPath } = useParams<{ '*': string }>();
  const isPreviewMode = useMatch('/connection/:connectionId/preview/:bucket/*') !== null;

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
    if (isPreviewMode && previewKey) {
      const fileName = previewKey.split('/').pop() || previewKey;
      document.title = `${fileName} - ${bucket} - s3browser`;
    } else if (currentPath) {
      document.title = `${bucket}/${currentPath} - s3browser`;
    } else {
      document.title = `${bucket} - s3browser`;
    }
  }, [bucket, currentPath, isPreviewMode, previewKey]);

  const buildUrl = useCallback((path: string) => buildBrowseUrl(connectionId, bucket, path), [connectionId, bucket]);

  return (
    <BrowserProvider currentPath={currentPath} buildUrl={buildUrl}>
      <S3Browser previewKey={previewKey} />
    </BrowserProvider>
  );
}
