import { useEffect, useRef } from 'react';
import { Download, File } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import type { S3Object } from '../../types';
import type { EmbedType } from '../../utils/previewUtils';

const cleanupIframe = (iframe: HTMLIFrameElement | null) => {
  if (!iframe) return;
  iframe.src = 'about:blank';
  iframe.removeAttribute('srcDoc');
};

const escapeHtmlAttr = (str: string): string => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

const buildMediaSrcdoc = (
  embedType: 'image' | 'video' | 'audio',
  signedUrl: string,
  alt: string,
): string => {
  const url = escapeHtmlAttr(signedUrl);
  const altText = escapeHtmlAttr(alt);
  const baseStyle =
    'body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:transparent}';

  switch (embedType) {
    case 'image':
      return `<!DOCTYPE html><html><head><style>${baseStyle}img{max-width:100%;max-height:100vh;object-fit:contain}</style></head><body><img src="${url}" alt="${altText}" /></body></html>`;
    case 'video':
      return `<!DOCTYPE html><html><head><style>${baseStyle}video{max-width:100%;max-height:100vh}</style></head><body><video controls src="${url}"></video></body></html>`;
    case 'audio':
      return `<!DOCTYPE html><html><head><style>${baseStyle}audio{width:100%;max-width:500px}</style></head><body><audio controls src="${url}"></audio></body></html>`;
  }
};

const getSandboxValue = (embedType: EmbedType): string => {
  // Chrome's native PDF viewer needs allow-same-origin to load the document.
  // This is safe without allow-scripts: no JS can execute, so the origin
  // access cannot be exploited programmatically.
  if (embedType === 'pdf') return 'allow-same-origin';
  return '';
};

interface PreviewDialogProps {
  open: boolean;
  isLoading: boolean;
  error: string | null;
  signedUrl: string | null;
  embedType: EmbedType;
  item: S3Object | null;
  cannotPreviewReason: string | null;
  onClose: () => void;
  onDownload: (key: string, versionId?: string) => void;
}

export function PreviewDialog({
  open,
  isLoading,
  error,
  signedUrl,
  embedType,
  item,
  cannotPreviewReason,
  onClose,
  onDownload,
}: PreviewDialogProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!open || !signedUrl) {
      cleanupIframe(iframeRef.current);
    }
  }, [open, signedUrl]);

  useEffect(() => {
    const iframe = iframeRef.current;
    return () => cleanupIframe(iframe);
  }, []);

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

    if (signedUrl !== null) {
      const title = item?.name || 'Preview';

      if (embedType === 'image' || embedType === 'video' || embedType === 'audio') {
        return (
          <iframe
            ref={iframeRef}
            sandbox={getSandboxValue(embedType)}
            srcDoc={buildMediaSrcdoc(embedType, signedUrl, title)}
            referrerPolicy="no-referrer"
            title={title}
            className="w-full h-full border-none"
          />
        );
      }

      // Text and PDF: load directly via src in sandboxed iframe
      return (
        <iframe
          ref={iframeRef}
          sandbox={getSandboxValue(embedType)}
          src={signedUrl}
          referrerPolicy="no-referrer"
          title={title}
          className="w-full h-full border-none"
        />
      );
    }

    return null;
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-[calc(100vw-64px)] max-h-[calc(100vh-64px)] w-[calc(100vw-64px)] h-[calc(100vh-64px)] flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <DialogTitle className="truncate pr-8">
            {item?.name || 'Preview'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0">
          {renderContent()}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t shrink-0">
          {!cannotPreviewReason && (
            <Button variant="outline" onClick={handleDownload} disabled={!item}>
              <Download className="h-4 w-4 mr-2" />
              Download
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
