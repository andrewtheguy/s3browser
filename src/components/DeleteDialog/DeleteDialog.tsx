import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  CircularProgress,
} from '@mui/material';
import type { S3Object } from '../../types';

interface DeleteDialogProps {
  open: boolean;
  item: S3Object | null;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteDialog({
  open,
  item,
  isDeleting,
  onConfirm,
  onCancel,
}: DeleteDialogProps) {
  if (!item) return null;

  const handleClose = (_event: object, _reason: 'backdropClick' | 'escapeKeyDown') => {
    if (isDeleting) {
      return;
    }
    onCancel();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      disableEscapeKeyDown={isDeleting}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>
        Delete {item.isFolder ? 'Folder' : 'File'}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          Are you sure you want to delete{' '}
          <strong>{item.name}</strong>
          {item.isFolder ? ' and all its contents' : ''}? This action cannot be
          undone.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={isDeleting}>
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          color="error"
          variant="contained"
          disabled={isDeleting}
        >
          {isDeleting ? (
            <CircularProgress size={20} color="inherit" />
          ) : (
            'Delete'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
