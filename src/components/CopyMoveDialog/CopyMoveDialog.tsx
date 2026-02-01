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
  LinearProgress,
  Typography,
} from '@mui/material';
import type { S3Object } from '../../types';
import type { CopyMoveOperation } from '../../services/api/objects';

interface CopyMoveDialogProps {
  open: boolean;
  mode: 'copy' | 'move';
  sourceItem: S3Object | null;
  destinationPath: string;
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
  isResolving,
  isExecuting,
  resolutionError,
  plan,
  progress,
  onConfirm,
  onCancel,
}: CopyMoveDialogProps) {
  if (!sourceItem) return null;

  const handleClose = (_event: object, _reason: 'backdropClick' | 'escapeKeyDown') => {
    if (isExecuting) return;
    onCancel();
  };

  const actionLabel = mode === 'copy' ? 'Copy' : 'Move';
  const actioningLabel = mode === 'copy' ? 'Copying' : 'Moving';
  const isFolder = sourceItem.isFolder;
  const totalOperations = plan?.operations.length ?? 0;
  const folderCount = plan?.folderKeys.length ?? 0;

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
            <strong>{destinationPath || '/ (root)'}</strong>?
          </>
        );
      }
      return (
        <>
          {actionLabel} <strong>{totalOperations} object{totalOperations === 1 ? '' : 's'}</strong>{' '}
          from <strong>{sourceItem.name}</strong> to{' '}
          <strong>{destinationPath || '/ (root)'}</strong>?
        </>
      );
    }
    return (
      <>
        {actionLabel} <strong>{sourceItem.name}</strong> to{' '}
        <strong>{destinationPath || '/ (root)'}</strong>?
      </>
    );
  };

  const previewKeys = plan?.operations.slice(0, PREVIEW_LIMIT).map((op) => op.sourceKey) ?? [];
  const remainingCount = Math.max(totalOperations - PREVIEW_LIMIT, 0);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      disableEscapeKeyDown={isExecuting}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>{getTitle()}</DialogTitle>
      <DialogContent>
        {resolutionError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {resolutionError}
          </Alert>
        )}

        <DialogContentText>{getMessage()}</DialogContentText>

        {/* Progress bar during execution */}
        {isExecuting && progress && (
          <Box sx={{ mt: 2 }}>
            <LinearProgress
              variant="determinate"
              value={(progress.completed / progress.total) * 100}
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              {progress.completed} / {progress.total} objects
            </Typography>
          </Box>
        )}

        {/* Loading spinner during resolution */}
        {isResolving && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={24} />
          </Box>
        )}

        {/* Folder info */}
        {isFolder && !isResolving && !resolutionError && folderCount > 0 && !isExecuting && (
          <DialogContentText sx={{ mt: 1 }}>
            {folderCount} subfolder{folderCount === 1 ? '' : 's'} will be recreated at the
            destination.
          </DialogContentText>
        )}

        {/* Preview list for folder operations */}
        {isFolder && !isResolving && !resolutionError && previewKeys.length > 0 && !isExecuting && (
          <Box sx={{ mt: 2 }}>
            <List dense sx={{ maxHeight: 320, overflow: 'auto' }}>
              {previewKeys.map((key) => (
                <ListItem key={key} sx={{ py: 0 }}>
                  <ListItemText
                    primary={key}
                    primaryTypographyProps={{
                      variant: 'body2',
                      sx: { wordBreak: 'break-all' },
                    }}
                  />
                </ListItem>
              ))}
            </List>
            {remainingCount > 0 && (
              <DialogContentText sx={{ mt: 1 }}>
                ...and {remainingCount} more
              </DialogContentText>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={isExecuting}>
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          variant="contained"
          color="primary"
          disabled={isExecuting || isResolving || !!resolutionError}
        >
          {isExecuting ? (
            <CircularProgress size={20} color="inherit" />
          ) : (
            actionLabel
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
