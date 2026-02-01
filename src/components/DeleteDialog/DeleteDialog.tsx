import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  CircularProgress,
  Box,
  List,
  ListItem,
  ListItemText,
  Alert,
} from '@mui/material';
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

  const handleClose = (_event: object, _reason: 'backdropClick' | 'escapeKeyDown') => {
    if (isDeleting) {
      return;
    }
    onCancel();
  };

  const isSingleItem = items.length === 1;
  const singleItem = items[0];
  const isFolder = isSingleItem && singleItem.isFolder;

  const resolvedTotalKeys = totalKeys ?? items.length;
  const remainingPreviewCount = Math.max(resolvedTotalKeys - previewKeys.length, 0);
  const batchTitle = resolvedTotalKeys === 0 && folderCount > 0
    ? `Delete ${folderCount} Folder${folderCount === 1 ? '' : 's'}`
    : `Delete ${resolvedTotalKeys} Object${resolvedTotalKeys === 1 ? '' : 's'}`;

  const title = isBatch
    ? batchTitle
    : isSingleItem
      ? isFolder ? 'Delete Folder' : 'Delete File'
      : `Delete ${items.length} Files`;

  const message = isBatch
    ? (
        <>
          {resolutionError
            ? 'Unable to load objects to delete.'
            : isResolving
            ? 'Gathering objects to delete...'
            : resolvedTotalKeys === 0 && folderCount > 0
              ? 'No objects found under the selected folders.'
              : (
                  <>
                    Are you sure you want to delete <strong>{resolvedTotalKeys} object{resolvedTotalKeys === 1 ? '' : 's'}</strong>? This action cannot be undone.
                  </>
                )}
        </>
      )
    : isSingleItem
      ? isFolder
        ? (
            <>
              Are you sure you want to delete the folder{' '}
              <strong>{singleItem.name}</strong>? The folder must be empty.
            </>
          )
        : (
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
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {resolutionError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {resolutionError}
          </Alert>
        )}
        <DialogContentText>{message}</DialogContentText>
        {isBatch && folderCount > 0 && !isResolving && !resolutionError && (
          <DialogContentText sx={{ mt: 1 }}>
            {resolvedTotalKeys === 0
              ? (folderCount === 1 ? 'The folder marker will be removed.' : 'Folder markers will be removed.')
              : (folderCount === 1
                  ? 'The folder will be removed after all objects are deleted.'
                  : 'Folders will be removed after all objects are deleted.')}
          </DialogContentText>
        )}
        {isBatch && !isResolving && !resolutionError && previewKeys.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <List dense sx={{ maxHeight: 220, overflow: 'hidden' }}>
              {previewKeys.map((key) => (
                <ListItem key={key} sx={{ py: 0 }}>
                  <ListItemText
                    primary={key}
                    primaryTypographyProps={{ variant: 'body2', sx: { wordBreak: 'break-all' } }}
                  />
                </ListItem>
              ))}
            </List>
            {remainingPreviewCount > 0 && (
              <DialogContentText sx={{ mt: 1 }}>
                …and {remainingPreviewCount} more
              </DialogContentText>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={isDeleting}>
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          color="error"
          variant="contained"
          disabled={isDeleting || isResolving || Boolean(resolutionError)}
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
