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
            <List dense sx={{ maxHeight: 320, overflow: 'auto' }}>
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
