import { AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import type { S3Object } from '../../types';

interface BatchDownloadDialogProps {
  open: boolean;
  items: S3Object[];
  isDownloading: boolean;
  isResolving?: boolean;
  previewKeys?: string[];
  totalKeys?: number;
  folderCount?: number;
  resolutionError?: string | null;
  progress?: { completed: number; total: number } | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function getMessage({
  resolutionError,
  isResolving,
  isDownloading,
  progress,
  resolvedTotalKeys,
  folderCount,
  itemsLength,
}: {
  resolutionError: string | null;
  isResolving: boolean;
  isDownloading: boolean;
  progress?: { completed: number; total: number } | null;
  resolvedTotalKeys: number;
  folderCount: number;
  itemsLength: number;
}): React.ReactNode {
  if (resolutionError) {
    return 'Unable to load objects to download.';
  }
  if (isResolving) {
    return 'Gathering objects to download...';
  }
  if (isDownloading) {
    if (progress) {
      return `Downloading ${progress.completed} of ${progress.total} objects...`;
    }
    return 'Downloading...';
  }
  if (resolvedTotalKeys === 0 && folderCount > 0) {
    return 'No objects found under the selected folders.';
  }
  if (resolvedTotalKeys === 0 && itemsLength > 0) {
    return 'No objects found to download.';
  }

  return (
    <>
      Download <strong>{resolvedTotalKeys} object{resolvedTotalKeys === 1 ? '' : 's'}</strong>? You will be prompted to
      choose a destination folder.
    </>
  );
}

export function BatchDownloadDialog({
  open,
  items,
  isDownloading,
  isResolving = false,
  previewKeys = [],
  totalKeys,
  folderCount = 0,
  resolutionError = null,
  progress,
  onConfirm,
  onCancel,
}: BatchDownloadDialogProps) {
  if (items.length === 0) return null;

  const resolvedTotalKeys = totalKeys ?? items.length;
  const remainingPreviewCount = Math.max(resolvedTotalKeys - previewKeys.length, 0);
  const title = isResolving
    ? 'Preparing download list'
    : resolvedTotalKeys === 0 && folderCount > 0
      ? `Download ${folderCount} Folder${folderCount === 1 ? '' : 's'}`
      : `Download ${resolvedTotalKeys} Object${resolvedTotalKeys === 1 ? '' : 's'}`;

  const message = getMessage({
    resolutionError,
    isResolving,
    isDownloading,
    progress,
    resolvedTotalKeys,
    folderCount,
    itemsLength: items.length,
  });

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !isDownloading && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {resolutionError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{resolutionError}</AlertDescription>
            </Alert>
          )}
          <DialogDescription>{message}</DialogDescription>
          {!isResolving && !resolutionError && !isDownloading && (
            <div className="space-y-1 text-sm text-muted-foreground">
              {resolvedTotalKeys > 0 ? (
                <p>
                  {resolvedTotalKeys} object{resolvedTotalKeys === 1 ? '' : 's'} will be downloaded.
                </p>
              ) : (
                <p>No objects to download.</p>
              )}
              {folderCount > 0 && (
                <p>
                  {folderCount} folder{folderCount === 1 ? '' : 's'} included from your selection.
                </p>
              )}
            </div>
          )}
          {!isResolving && !resolutionError && previewKeys.length > 0 && (
            <div>
              <ScrollArea className="h-[320px] rounded-md border">
                <div className="p-2 space-y-1">
                  <ul className="space-y-1">
                    {previewKeys.map((key) => (
                      <li key={key} className="text-sm break-all py-1">
                        {key}
                      </li>
                    ))}
                  </ul>
                  {remainingPreviewCount > 0 && (
                    <div className="text-sm text-muted-foreground pt-2 mt-2">
                      ...and {remainingPreviewCount} more
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isDownloading}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={
              isDownloading ||
              isResolving ||
              Boolean(resolutionError) ||
              resolvedTotalKeys === 0
            }
          >
            {isDownloading ? <Spinner size="sm" className="text-white" /> : 'Download'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
