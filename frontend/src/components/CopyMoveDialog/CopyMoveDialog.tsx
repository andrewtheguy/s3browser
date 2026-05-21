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
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import type { S3Object } from '../../types';
import type { CopyMoveOperation } from '../../services/api/objects';

interface CopyMoveDialogProps {
  open: boolean;
  mode: 'copy' | 'move';
  sourceItem: S3Object | null;
  destinationPath: string;
  newName: string;
  isResolving: boolean;
  isExecuting: boolean;
  resolutionError: string | null;
  plan: { operations: CopyMoveOperation[]; folderKeys: string[] } | null;
  progress?: { completed: number; total: number };
  onConfirm: () => void;
  onCancel: () => void;
}

const PREVIEW_LIMIT = 50;

export function CopyMoveDialog({
  open,
  mode,
  sourceItem,
  destinationPath,
  newName,
  isResolving,
  isExecuting,
  resolutionError,
  plan,
  progress,
  onConfirm,
  onCancel,
}: CopyMoveDialogProps) {
  if (!sourceItem) return null;

  const actionLabel = mode === 'copy' ? 'Copy' : 'Move';
  const actioningLabel = mode === 'copy' ? 'Copying' : 'Moving';
  const isFolder = sourceItem.isFolder;
  const totalOperations = plan?.operations.length ?? 0;
  const folderCount = plan?.folderKeys.length ?? 0;

  // Compute full destination for display
  const fullDestination = destinationPath + newName + (isFolder ? '/' : '');
  const isRename = newName !== sourceItem.name;

  const getTitle = () => {
    if (isExecuting) {
      return `${actioningLabel}...`;
    }
    if (isFolder) {
      return `${actionLabel} Folder`;
    }
    return `${actionLabel} File`;
  };

  const getMessage = () => {
    if (resolutionError) {
      return `Unable to prepare ${mode} operation.`;
    }
    if (isResolving) {
      return `Gathering objects to ${mode}...`;
    }
    if (isExecuting && progress) {
      return `${actioningLabel} ${progress.completed} of ${progress.total} objects...`;
    }
    if (isFolder) {
      if (totalOperations === 0 && folderCount > 0) {
        return (
          <>
            {actionLabel} empty folder <strong>{sourceItem.name}</strong> to{' '}
            <strong>{fullDestination || '/'}</strong>
            {isRename && <> (renamed to <strong>{newName}</strong>)</>}?
          </>
        );
      }
      return (
        <>
          {actionLabel} <strong>{totalOperations} object{totalOperations === 1 ? '' : 's'}</strong>{' '}
          from <strong>{sourceItem.name}</strong> to{' '}
          <strong>{fullDestination || '/'}</strong>
          {isRename && <> (renamed to <strong>{newName}</strong>)</>}?
        </>
      );
    }
    return (
      <>
        {actionLabel} <strong>{sourceItem.name}</strong> to{' '}
        <strong>{fullDestination || '/'}</strong>
        {isRename && <> (renamed to <strong>{newName}</strong>)</>}?
      </>
    );
  };

  const previewKeys = plan?.operations.slice(0, PREVIEW_LIMIT).map((op) => op.sourceKey) ?? [];
  const remainingCount = Math.max(totalOperations - PREVIEW_LIMIT, 0);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !isExecuting && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {resolutionError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{resolutionError}</AlertDescription>
            </Alert>
          )}

          <DialogDescription>{getMessage()}</DialogDescription>

          {/* Progress bar during execution */}
          {isExecuting && progress && (
            <div className="space-y-2">
              <Progress
                value={progress.total > 0 ? Math.min((progress.completed / progress.total) * 100, 100) : 0}
              />
              <p className="text-xs text-muted-foreground">
                {progress.completed} / {progress.total} objects
              </p>
            </div>
          )}

          {/* Loading spinner during resolution */}
          {isResolving && (
            <div className="flex justify-center py-4">
              <Spinner size="md" />
            </div>
          )}

          {/* Folder info */}
          {isFolder && !isResolving && !resolutionError && folderCount > 0 && !isExecuting && (
            <p className="text-sm text-muted-foreground">
              {folderCount} subfolder{folderCount === 1 ? '' : 's'} will be recreated at the
              destination.
            </p>
          )}

          {/* Preview list for folder operations */}
          {isFolder && !isResolving && !resolutionError && previewKeys.length > 0 && !isExecuting && (
            <div>
              <ScrollArea className="h-[320px] rounded-md border">
                <ul className="p-2 space-y-1">
                  {previewKeys.map((key) => (
                    <li key={key} className="text-sm break-all py-1">
                      {key}
                    </li>
                  ))}
                </ul>
              </ScrollArea>
              {remainingCount > 0 && (
                <p className="text-sm text-muted-foreground mt-2">
                  ...and {remainingCount} more
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isExecuting}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isExecuting || isResolving || !!resolutionError}
          >
            {isExecuting ? (
              <Spinner size="sm" className="text-white" />
            ) : (
              actionLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
