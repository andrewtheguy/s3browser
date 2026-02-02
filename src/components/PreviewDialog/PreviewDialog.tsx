import { useState, useCallback } from 'react';
import { Download, File, RefreshCw } from 'lucide-react';
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

interface PreviewDialogProps {
  open: boolean;
  isLoading: boolean;
  error: string | null;
  signedUrl: string | null;
  embedType: EmbedType;
  item: S3Object | null;
  cannotPreviewReason: string | null;
  onClose: () => void;
  onDownload: (key: string) => void;
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
  // Track error with the URL that caused it, so error auto-clears when URL changes
  const [mediaError, setMediaError] = useState<{ url: string; message: string } | null>(null);

  // Only show error if it's for the current signedUrl
  const mediaLoadError = mediaError?.url === signedUrl ? mediaError.message : null;

  const handleDownload = () => {
    if (item) {
      onDownload(item.key);
    }
  };

  const handleMediaError = useCallback(
    (mediaType: 'video' | 'audio') => {
      if (signedUrl) {
        console.error(`Failed to load ${mediaType}:`, signedUrl);
        setMediaError({
          url: signedUrl,
          message: `${mediaType === 'video' ? 'Video' : 'Audio'} failed to load`,
        });
      }
    },
    [signedUrl]
  );

  const handleRetry = useCallback(() => {
    setMediaError(null);
  }, []);

  const renderMediaError = () => (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
      <File className="h-16 w-16 mb-2 opacity-50" />
      <h3 className="text-lg font-semibold mb-1">{mediaLoadError}</h3>
      <p className="text-sm text-center mb-4">
        The file could not be played. Try again or download the file.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={handleRetry}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
        <Button onClick={handleDownload} disabled={!item}>
          <Download className="h-4 w-4 mr-2" />
          Download
        </Button>
      </div>
    </div>
  );

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
      if (embedType === 'image') {
        return (
          <div className="flex items-center justify-center h-full p-2 bg-muted/30">
            <img
              src={signedUrl}
              alt={item?.name || 'Preview'}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        );
      }

      if (embedType === 'video') {
        if (mediaLoadError) {
          return renderMediaError();
        }
        return (
          <div className="flex items-center justify-center h-full p-2 bg-muted/30">
            <video
              controls
              src={signedUrl}
              onError={() => handleMediaError('video')}
              className="max-w-full max-h-full"
            />
          </div>
        );
      }

      if (embedType === 'audio') {
        if (mediaLoadError) {
          return renderMediaError();
        }
        return (
          <div className="flex items-center justify-center h-full p-2">
            <audio
              controls
              src={signedUrl}
              onError={() => handleMediaError('audio')}
              className="w-full max-w-[500px]"
            />
          </div>
        );
      }

      // For text and PDF, use iframe
      return (
        <iframe
          src={signedUrl}
          title={item?.name || 'Preview'}
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
