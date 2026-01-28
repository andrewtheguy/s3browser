import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  IconButton,
  Typography,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Chip,
  Divider,
  Tooltip,
  Alert,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import { useBrowserContext } from '../../contexts';
import { useUpload } from '../../hooks';
import { DropZone } from './DropZone';
import { UploadProgress } from './UploadProgress';
import { formatFileSize } from '../../utils/formatters';

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
    upload,
    cancelUpload,
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
    async (files: File[]) => {
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
      await upload([file], ''); // Use the key from pending upload (already includes path)
    },
    [pendingToResume, upload]
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
        {/* Hidden file input for resuming uploads */}
        <input
          type="file"
          ref={resumeFileInputRef}
          onChange={handleResumeFileSelect}
          style={{ display: 'none' }}
        />

        {/* Resume error alert */}
        {resumeError && (
          <Alert severity="error" onClose={() => setResumeError(null)} sx={{ mb: 2 }}>
            {resumeError}
          </Alert>
        )}

        {/* Pending Resumable Uploads Section */}
        {pendingResumable.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="warning.main" gutterBottom>
              Resume Pending Uploads ({pendingResumable.length})
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              These uploads were interrupted. Re-select the same file to resume.
            </Typography>
            <List dense sx={(theme) => ({ bgcolor: alpha(theme.palette.warning.light, 0.5), borderRadius: 1 })}>
              {pendingResumable.map((pending) => (
                <ListItem
                  key={pending.id}
                  secondaryAction={
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <Tooltip title="Re-select file to resume upload">
                        <IconButton
                          size="small"
                          onClick={() => handleResumeFromPending(pending)}
                        >
                          <CloudUploadIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Discard">
                        <IconButton
                          size="small"
                          onClick={() => removePendingResumable(pending.id)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  }
                >
                  <ListItemIcon sx={{ minWidth: 40 }}>
                    <CloudUploadIcon color="warning" />
                  </ListItemIcon>
                  <ListItemText
                    primary={
                      <Typography variant="body2" noWrap sx={{ maxWidth: { xs: 120, sm: 200, md: 280 } }}>
                        {pending.fileName}
                      </Typography>
                    }
                    secondary={
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                        <Chip
                          size="small"
                          label={formatFileSize(pending.fileSize)}
                          sx={{ fontSize: '0.65rem' }}
                        />
                        <Chip
                          size="small"
                          label={`${pending.completedParts.length}/${pending.totalParts} parts`}
                          variant="outlined"
                          sx={{ fontSize: '0.65rem' }}
                        />
                      </Box>
                    }
                  />
                </ListItem>
              ))}
            </List>
            <Divider sx={{ my: 2 }} />
          </Box>
        )}

        <Box sx={{ mb: 2 }}>
          <DropZone onFilesSelected={handleFilesSelected} disabled={isUploading} />
        </Box>
        <UploadProgress
          uploads={uploads}
          onCancel={cancelUpload}
          onPause={pauseUpload}
          onResume={resumeUpload}
          onRetry={retryUpload}
        />
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
