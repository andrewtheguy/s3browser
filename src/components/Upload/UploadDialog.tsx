import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Trash2, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useBrowserContext } from '../../contexts';
import { useUpload } from '../../hooks';
import { DropZone } from './DropZone';
import { UploadProgress } from './UploadProgress';
import { formatFileSize } from '../../utils/formatters';
import type { UploadCandidate } from '../../types';

interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
  onUploadComplete: () => void;
}

export function UploadDialog({
  open,
  onClose,
  onUploadComplete,
}: UploadDialogProps) {
  const { currentPath } = useBrowserContext();
  const {
    uploads,
    pendingResumable,
    completedStats,
    upload,
    cancelUpload,
    cancelAll,
    pauseUpload,
    resumeUpload,
    retryUpload,
    clearAll,
    removePendingResumable,
    isUploading,
  } = useUpload();

  // State and ref for resuming pending uploads via file picker
  const resumeFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingToResume, setPendingToResume] = useState<typeof pendingResumable[0] | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const handleFilesSelected = useCallback(
    async (files: UploadCandidate[]) => {
      await upload(files, currentPath);
    },
    [upload, currentPath]
  );

  const handleResumeFromPending = useCallback(
    (pending: typeof pendingResumable[0]) => {
      setPendingToResume(pending);
      setResumeError(null);
      // Trigger file picker
      if (resumeFileInputRef.current) {
        resumeFileInputRef.current.value = '';
        resumeFileInputRef.current.click();
      }
    },
    []
  );

  const handleResumeFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Clear input for future use
      if (resumeFileInputRef.current) {
        resumeFileInputRef.current.value = '';
      }

      if (!file || !pendingToResume) {
        setPendingToResume(null);
        return;
      }

      // Verify file matches the pending upload (name and size)
      if (file.name !== pendingToResume.fileName || file.size !== pendingToResume.fileSize) {
        setResumeError(
          `File mismatch: Expected "${pendingToResume.fileName}" (${formatFileSize(pendingToResume.fileSize)}), ` +
          `got "${file.name}" (${formatFileSize(file.size)}). Please select the correct file.`
        );
        setPendingToResume(null);
        return;
      }

      // File matches - upload will automatically detect and resume the pending upload
      setResumeError(null);
      setPendingToResume(null);
      await upload([{ file, key: pendingToResume.key }], ''); // Use the key from pending upload (already includes path)
    },
    [pendingToResume, upload]
  );

  const handleClose = useCallback(async () => {
    if (isUploading) {
      // Optionally show a confirmation
      const confirmed = window.confirm(
        'Uploads are in progress. Are you sure you want to close?'
      );
      if (!confirmed) return;
      await clearAll();
    }
    onClose();
  }, [isUploading, clearAll, onClose]);

  // Track whether onUploadComplete has been called for current batch
  const completedCallbackFiredRef = useRef(false);
  const previousUploadCountRef = useRef(0);

  // Refresh file list when all uploads complete
  useEffect(() => {
    const hasUploading = uploads.some((u) => u.status === 'uploading');
    const hasPending = uploads.some((u) => u.status === 'pending');
    const completedCount = uploads.filter((u) => u.status === 'completed').length;

    // Reset flag when new uploads are added
    if (uploads.length > previousUploadCountRef.current || hasPending || hasUploading) {
      completedCallbackFiredRef.current = false;
    }
    previousUploadCountRef.current = uploads.length;

    // Fire callback only once when all uploads finish
    if (completedCount > 0 && !hasUploading && !hasPending && !completedCallbackFiredRef.current) {
      completedCallbackFiredRef.current = true;
      onUploadComplete();
    }
  }, [uploads, onUploadComplete]);

  const hasCancelableUploads = uploads.length > 0;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Hidden file input for resuming uploads */}
          <input
            type="file"
            ref={resumeFileInputRef}
            onChange={handleResumeFileSelect}
            className="hidden"
          />

          {/* Resume error alert */}
          {resumeError && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between">
                {resumeError}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setResumeError(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* Pending Resumable Uploads Section */}
          {pendingResumable.length > 0 && (
            <TooltipProvider>
              <div>
                <p className="text-sm font-medium text-yellow-600 mb-1">
                  Resume Pending Uploads ({pendingResumable.length})
                </p>
                <p className="text-xs text-muted-foreground mb-2">
                  These uploads were interrupted. Re-select the same file to resume.
                </p>
                <ScrollArea className="max-h-[200px] rounded-md border border-yellow-200 bg-yellow-50/50">
                  <ul className="p-2 space-y-2">
                    {pendingResumable.map((pending) => (
                      <li
                        key={pending.id}
                        className="flex items-center justify-between gap-2 bg-background rounded p-2"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Upload className="h-4 w-4 text-yellow-600 flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm truncate max-w-[120px] sm:max-w-[200px] md:max-w-[280px]">
                              {pending.key || pending.fileName}
                            </p>
                            <div className="flex gap-1 mt-1">
                              <Badge variant="secondary" className="text-xs">
                                {formatFileSize(pending.fileSize)}
                              </Badge>
                              <Badge variant="outline" className="text-xs">
                                {pending.completedParts.length}/{pending.totalParts} parts
                              </Badge>
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => handleResumeFromPending(pending)}
                              >
                                <Upload className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Re-select file to resume upload</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => removePendingResumable(pending.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Discard</TooltipContent>
                          </Tooltip>
                        </div>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
                <Separator className="my-4" />
              </div>
            </TooltipProvider>
          )}

          <DropZone onFilesSelected={handleFilesSelected} disabled={isUploading} />

          <UploadProgress
            uploads={uploads}
            completedStats={completedStats}
            onCancel={cancelUpload}
            onPause={pauseUpload}
            onResume={resumeUpload}
            onRetry={retryUpload}
          />
        </div>
        <DialogFooter className="flex-wrap gap-2">
          {hasCancelableUploads && (
            <Button variant="destructive" onClick={cancelAll}>
              Cancel All
            </Button>
          )}
          <Button onClick={handleClose} disabled={isUploading}>
            {isUploading ? 'Uploading...' : 'Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
