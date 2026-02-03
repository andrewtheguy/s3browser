import { useCallback, useEffect, useRef } from 'react';
import { Upload, Trash2 } from 'lucide-react';
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
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
    retryUpload,
    clearAll,
    removePendingResumable,
    isUploading,
    isUploadBlocked,
  } = useUpload();

  const handleFilesSelected = useCallback(
    async (files: UploadCandidate[]) => {
      await upload(files, currentPath);
    },
    [upload, currentPath]
  );

  const handleClose = useCallback(async () => {
    if (isUploading) {
      // Optionally show a confirmation
      const confirmed = window.confirm(
        'Uploads are in progress. Are you sure you want to close?'
      );
      if (!confirmed) return;
    }
    await clearAll();
    onClose();
  }, [isUploading, clearAll, onClose]);

  // Track whether onUploadComplete has been called for current batch
  const completedCallbackFiredRef = useRef(false);
  const previousUploadCountRef = useRef(0);

  // Refresh file list when all uploads complete
  useEffect(() => {
    const hasUploading = uploads.some((u) => u.status === 'uploading');
    const hasPending = uploads.some((u) => u.status === 'pending');
    const hasActive = hasUploading || hasPending;
    const completedCount = completedStats.count;

    // Reset flag when new uploads are added
    if (uploads.length > previousUploadCountRef.current || hasActive) {
      completedCallbackFiredRef.current = false;
    }
    previousUploadCountRef.current = uploads.length;

    // Fire callback only once when all uploads finish
    if (completedCount > 0 && !hasActive && !completedCallbackFiredRef.current) {
      completedCallbackFiredRef.current = true;
      onUploadComplete();
    }
  }, [uploads, completedStats.count, onUploadComplete]);

  const hasCancelableUploads = uploads.some((item) => item.status !== 'completed');

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {isUploadBlocked && (
            <Alert variant="destructive">
              <AlertDescription>
                Uploads are active in another tab. Close that tab or wait for it to finish before starting a new upload.
              </AlertDescription>
            </Alert>
          )}

          <DropZone onFilesSelected={handleFilesSelected} disabled={isUploading || isUploadBlocked} />

          <UploadProgress
            uploads={uploads}
            completedStats={completedStats}
            onCancel={cancelUpload}
            onRetry={retryUpload}
          />

          {/* Pending Resumable Uploads Section */}
          <TooltipProvider>
            <div>
              <Separator className="my-4" />
              <Accordion type="single" collapsible>
                <AccordionItem value="pending-uploads">
                  <AccordionTrigger className="text-sm font-medium text-yellow-700">
                    Pending Uploads ({pendingResumable.length})
                  </AccordionTrigger>
                  <AccordionContent>
                    {pendingResumable.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No pending uploads to resume.
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground mb-2">
                          These uploads resume automatically when possible. If they stay pending after a reload, re-add the same file.
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
                      </>
                    )}
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </TooltipProvider>
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
