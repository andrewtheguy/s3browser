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
  items: S3Object[];
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteDialog({
  open,
  items,
  isDeleting,
  onConfirm,
  onCancel,
}: DeleteDialogProps) {
  if (items.length === 0) return null;

  const handleClose = (_event: object, _reason: 'backdropClick' | 'escapeKeyDown') => {
    if (isDeleting) {
      return;
    }
    onCancel();
  };

  const isSingleItem = items.length === 1;
  const singleItem = items[0];

  const title = isSingleItem
    ? 'Delete File'
    : `Delete ${items.length} Files`;

  const message = isSingleItem
    ? (
        <>
          Are you sure you want to delete{' '}
          <strong>{singleItem.name}</strong>? This action cannot be undone.
        </>
      )
    : (
        <>
          Are you sure you want to delete <strong>{items.length} files</strong>? This action cannot be undone.
        </>
      );

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      disableEscapeKeyDown={isDeleting}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{message}</DialogContentText>
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
