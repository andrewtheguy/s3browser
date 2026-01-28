import { useCallback, useEffect } from 'react';
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

  // Refresh file list when all uploads complete
  useEffect(() => {
    const hasCompleted = uploads.some((u) => u.status === 'completed');
    const hasUploading = uploads.some((u) => u.status === 'uploading');

    if (hasCompleted && !hasUploading) {
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
