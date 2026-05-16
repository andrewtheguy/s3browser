import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, File } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { S3Object } from '../../types';
import {
  getHighlightLanguage,
  isJsonFile,
  type EmbedType,
} from '../../utils/previewUtils';
import { TextPreview } from './TextPreview';

const cleanupIframe = (iframe: HTMLIFrameElement | null) => {
  if (!iframe) return;
  iframe.src = 'about:blank';
  iframe.removeAttribute('srcDoc');
};

const buildImageSrcdoc = (signedUrl: string, alt: string): string => {
  const doc = document.implementation.createHTMLDocument('');
  const style = doc.createElement('style');
  style.textContent =
    'body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:transparent}' +
    'img{max-width:100%;max-height:100vh;object-fit:contain}';
  const image = doc.createElement('img');
  image.src = signedUrl;
  image.alt = alt;
  doc.head.append(style);
  doc.body.append(image);
  return new XMLSerializer().serializeToString(doc);
};

export interface PreviewBodyProps {
  isLoading: boolean;
  error: string | null;
  signedUrl: string | null;
  textContent: string | null;
  embedType: EmbedType;
  item: S3Object | null;
  cannotPreviewReason: string | null;
  onDownload: (key: string, versionId?: string) => void;
}

export function PreviewBody({
  isLoading,
  error,
  signedUrl,
  textContent,
  embedType,
  item,
  cannotPreviewReason,
  onDownload,
}: PreviewBodyProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [prettyJson, setPrettyJson] = useState(true);
  const [prevItemId, setPrevItemId] = useState<string | undefined>(
    item ? `${item.key}::${item.versionId ?? ''}` : undefined
  );
  const itemId = item ? `${item.key}::${item.versionId ?? ''}` : undefined;
  if (itemId !== prevItemId) {
    setPrevItemId(itemId);
    setPrettyJson(true);
  }

  useEffect(() => {
    if (!signedUrl) {
      cleanupIframe(iframeRef.current);
    }
  }, [signedUrl]);

  useEffect(() => {
    const iframe = iframeRef.current;
    return () => cleanupIframe(iframe);
  }, []);

  const showJsonToggle =
    embedType === 'text' &&
    item != null &&
    isJsonFile(item.name) &&
    textContent !== null;

  const { displayedText, jsonError } = useMemo(() => {
    if (textContent === null) {
      return { displayedText: null, jsonError: false };
    }
    if (!prettyJson || !item || !isJsonFile(item.name)) {
      return { displayedText: textContent, jsonError: false };
    }
    try {
      return {
        displayedText: JSON.stringify(JSON.parse(textContent), null, 2),
        jsonError: false,
      };
    } catch {
      return { displayedText: textContent, jsonError: true };
    }
  }, [textContent, prettyJson, item]);

  const handleDownload = () => {
    if (item) {
      onDownload(item.key, item.versionId);
    }
  };

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center h-full">
          <Spinner size="lg" />
        </div>
      );
    }

    if (error) {
      return (
        <div className="p-2">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      );
    }

    if (cannotPreviewReason) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <File className="h-16 w-16 mb-2 opacity-50" />
          <h3 className="text-lg font-semibold mb-1">Cannot Preview File</h3>
          <p className="text-sm text-center">
            {cannotPreviewReason}
          </p>
          <Button
            onClick={handleDownload}
            disabled={!item}
            className="mt-6"
          >
            <Download className="h-4 w-4 mr-2" />
            Download File
          </Button>
        </div>
      );
    }

    if (embedType === 'text') {
      if (displayedText === null) {
        return (
          <div className="flex items-center justify-center h-full">
            <Spinner size="lg" />
          </div>
        );
      }
      const language = item ? getHighlightLanguage(item.name) : undefined;
      return (
        <div className="flex h-full flex-col">
          {jsonError && (
            <div className="px-4 py-2 text-xs text-muted-foreground border-b shrink-0">
              Invalid JSON — showing raw content.
            </div>
          )}
          <div className="flex-1 min-h-0">
            <TextPreview content={displayedText} language={language} />
          </div>
        </div>
      );
    }

    if (signedUrl !== null) {
      const title = item?.name || 'Preview';

      if (embedType === 'pdf') {
        return (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <File className="h-16 w-16 mb-2 opacity-50" />
            <h3 className="text-lg font-semibold mb-1">Open PDF Preview</h3>
            <p className="text-sm text-center">
              PDF previews open in a new browser tab.
            </p>
            <Button
              asChild
              className="mt-6"
            >
              <a
                href={signedUrl}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Open in New Tab
              </a>
            </Button>
          </div>
        );
      }

      if (embedType === 'audio') {
        return (
          <div className="flex h-full items-center justify-center p-4">
            <audio
              controls
              preload="auto"
              src={signedUrl}
              className="w-full max-w-md"
            >
              <a href={signedUrl}>Download audio</a>
            </audio>
          </div>
        );
      }

      if (embedType === 'video') {
        return (
          <div className="flex h-full items-center justify-center p-4">
            <video
              controls
              preload="auto"
              src={signedUrl}
              className="max-w-full max-h-full"
            >
              <a href={signedUrl}>Download video</a>
            </video>
          </div>
        );
      }

      if (embedType === 'image') {
        return (
          <iframe
            ref={iframeRef}
            sandbox=""
            srcDoc={buildImageSrcdoc(signedUrl, title)}
            referrerPolicy="no-referrer"
            title={title}
            className="w-full h-full border-none"
          />
        );
      }
    }

    return null;
  };

  return (
    <>
      {showJsonToggle && (
        <div className="flex items-center gap-2 px-4 sm:px-6 py-2 border-b shrink-0">
          <Checkbox
            id="preview-pretty-json"
            checked={prettyJson}
            onCheckedChange={(checked) => setPrettyJson(checked === true)}
          />
          <Label htmlFor="preview-pretty-json" className="cursor-pointer text-sm font-normal">
            Pretty format
          </Label>
        </div>
      )}
      <div className="flex-1 overflow-auto min-h-0">
        {renderContent()}
      </div>
    </>
  );
}
