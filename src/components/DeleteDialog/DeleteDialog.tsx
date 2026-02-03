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

interface DeleteDialogProps {
  open: boolean;
  items: S3Object[];
  isDeleting: boolean;
  isResolving?: boolean;
  previewKeys?: string[];
  totalKeys?: number;
  folderCount?: number;
  isBatch?: boolean;
  resolutionError?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function getMessage({
  isBatch,
  resolutionError,
  isResolving,
  resolvedTotalKeys,
  folderCount,
  isSingleItem,
  isFolder,
  singleItem,
  itemsLength,
}: {
  isBatch: boolean;
  resolutionError: string | null;
  isResolving: boolean;
  resolvedTotalKeys: number;
  folderCount: number;
  isSingleItem: boolean;
  isFolder: boolean;
  singleItem: S3Object;
  itemsLength: number;
}): React.ReactNode {
  if (isBatch) {
    if (resolutionError) {
      return 'Unable to load objects to delete.';
    }
    if (isResolving) {
      return 'Gathering objects to delete...';
    }
    if (resolvedTotalKeys === 0 && folderCount > 0) {
      return 'No objects found under the selected folders.';
    }
    return (
      <>
        Are you sure you want to delete{' '}
        <strong>{resolvedTotalKeys} object{resolvedTotalKeys === 1 ? '' : 's'}</strong>? This action cannot be undone.
      </>
    );
  }

  if (isSingleItem) {
    if (isFolder) {
      return (
        <>
          Are you sure you want to delete the folder{' '}
          <strong>{singleItem.name}</strong> and all its contents? This action cannot be undone.
        </>
      );
    }

    return (
      <>
        Are you sure you want to delete{' '}
        <strong>{singleItem.name}</strong>? This action cannot be undone.
      </>
    );
  }

  return (
    <>
      Are you sure you want to delete <strong>{itemsLength} files</strong>? This action cannot be undone.
    </>
  );
}

export function DeleteDialog({
  open,
  items,
  isDeleting,
  isResolving = false,
  previewKeys = [],
  totalKeys,
  folderCount = 0,
  isBatch = false,
  resolutionError = null,
  onConfirm,
  onCancel,
}: DeleteDialogProps) {
  if (items.length === 0) return null;

  const isSingleItem = items.length === 1;
  const singleItem = items[0];
  const isFolder = isSingleItem && singleItem.isFolder;

  const resolvedTotalKeys = totalKeys ?? items.length;
  const remainingPreviewCount = Math.max(resolvedTotalKeys - previewKeys.length, 0);
  const batchTitle = isResolving
    ? 'Preparing delete list'
    : resolvedTotalKeys === 0 && folderCount > 0
      ? `Delete ${folderCount} Folder${folderCount === 1 ? '' : 's'}`
      : `Delete ${resolvedTotalKeys} Object${resolvedTotalKeys === 1 ? '' : 's'}`;

  const title = isBatch
    ? batchTitle
    : isSingleItem
      ? isFolder ? 'Delete Folder' : 'Delete File'
      : `Delete ${items.length} Files`;

  const message = getMessage({
    isBatch,
    resolutionError,
    isResolving,
    resolvedTotalKeys,
    folderCount,
    isSingleItem,
    isFolder,
    singleItem,
    itemsLength: items.length,
  });

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !isDeleting && onCancel()}>
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
          {isBatch && !isResolving && !resolutionError && (
            <div className="space-y-1 text-sm text-muted-foreground">
              {!(resolvedTotalKeys === 0 && folderCount > 0) && (
                <p>
                  {resolvedTotalKeys === 0
                    ? 'No objects found to delete.'
                    : `${resolvedTotalKeys} object${resolvedTotalKeys === 1 ? '' : 's'} will be deleted.`}
                </p>
              )}
              {folderCount > 0 && (
                <p>
                  {resolvedTotalKeys === 0
                    ? (folderCount === 1 ? 'The folder marker will be removed.' : 'Folder markers will be removed.')
                    : (folderCount === 1
                        ? '1 folder will be removed after all objects are deleted.'
                        : `${folderCount} folders will be removed after all objects are deleted.`)}
                </p>
              )}
            </div>
          )}
          {isBatch && !isResolving && !resolutionError && previewKeys.length > 0 && (
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
          <Button variant="outline" onClick={onCancel} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isDeleting || isResolving || Boolean(resolutionError)}
          >
            {isDeleting ? (
              <Spinner size="sm" className="text-white" />
            ) : (
              'Delete'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
