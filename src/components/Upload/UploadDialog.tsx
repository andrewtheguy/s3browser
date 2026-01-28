import { useCallback, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useBrowserContext } from '../../contexts';
import { useUpload } from '../../hooks';
import { DropZone } from './DropZone';
import { UploadProgress } from './UploadProgress';

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
  const { uploads, upload, cancelUpload, clearAll, isUploading } = useUpload();

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      await upload(files, currentPath);
    },
    [upload, currentPath]
  );

  const handleClose = useCallback(() => {
    if (isUploading) {
      // Optionally show a confirmation
      const confirmed = window.confirm(
        'Uploads are in progress. Are you sure you want to close?'
      );
      if (!confirmed) return;
      clearAll();
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

  const completedCount = uploads.filter((u) => u.status === 'completed').length;
  const hasCompletedUploads = completedCount > 0;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={isUploading}
    >
      <DialogTitle>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Upload Files
          <IconButton onClick={handleClose} size="small">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent>
        <Box sx={{ mb: 2 }}>
          <DropZone onFilesSelected={handleFilesSelected} disabled={isUploading} />
        </Box>
        <UploadProgress uploads={uploads} onCancel={cancelUpload} />
      </DialogContent>
      <DialogActions>
        {hasCompletedUploads && (
          <Button onClick={clearAll} color="inherit">
            Clear Completed
          </Button>
        )}
        <Button onClick={handleClose} disabled={isUploading}>
          {isUploading ? 'Uploading...' : 'Close'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
