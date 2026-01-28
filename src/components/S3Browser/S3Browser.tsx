import { useState, useCallback } from 'react';
import {
  Box,
  Paper,
  Snackbar,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
} from '@mui/material';
import { Toolbar } from '../Toolbar';
import { FileList } from '../FileList';
import { UploadDialog } from '../Upload';
import { DeleteDialog } from '../DeleteDialog';
import { useBrowserContext } from '../../contexts';
import { useDelete, useUpload } from '../../hooks';
import type { S3Object } from '../../types';

interface SnackbarState {
  open: boolean;
  message: string;
  severity: 'success' | 'error' | 'info' | 'warning';
}

export function S3Browser() {
  const { refresh, currentPath } = useBrowserContext();
  const { remove, isDeleting } = useDelete();
  const { createNewFolder } = useUpload();

  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<S3Object | null>(null);
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [snackbar, setSnackbar] = useState<SnackbarState>({
    open: false,
    message: '',
    severity: 'success',
  });

  const showSnackbar = useCallback(
    (message: string, severity: SnackbarState['severity']) => {
      setSnackbar({ open: true, message, severity });
    },
    []
  );

  const handleSnackbarClose = useCallback(() => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  }, []);

  const handleUploadClick = useCallback(() => {
    setUploadDialogOpen(true);
  }, []);

  const handleUploadDialogClose = useCallback(() => {
    setUploadDialogOpen(false);
  }, []);

  const handleUploadComplete = useCallback(() => {
    void refresh();
    showSnackbar('Files uploaded successfully', 'success');
  }, [refresh, showSnackbar]);

  const handleDeleteRequest = useCallback((item: S3Object) => {
    setItemToDelete(item);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!itemToDelete) return;

    try {
      await remove(itemToDelete.key);
      showSnackbar(
        `${itemToDelete.isFolder ? 'Folder' : 'File'} deleted successfully`,
        'success'
      );
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      showSnackbar(message, 'error');
    } finally {
      setDeleteDialogOpen(false);
      setItemToDelete(null);
    }
  }, [itemToDelete, remove, refresh, showSnackbar]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteDialogOpen(false);
    setItemToDelete(null);
  }, []);

  const handleCreateFolderClick = useCallback(() => {
    setNewFolderName('');
    setCreateFolderDialogOpen(true);
  }, []);

  const handleCreateFolderConfirm = useCallback(async () => {
    if (!newFolderName.trim()) return;

    setIsCreatingFolder(true);
    try {
      await createNewFolder(newFolderName.trim(), currentPath);
      showSnackbar('Folder created successfully', 'success');
      await refresh();
      setCreateFolderDialogOpen(false);
      setNewFolderName('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create folder';
      showSnackbar(message, 'error');
    } finally {
      setIsCreatingFolder(false);
    }
  }, [newFolderName, currentPath, createNewFolder, refresh, showSnackbar]);

  const handleCreateFolderCancel = useCallback(() => {
    setCreateFolderDialogOpen(false);
    setNewFolderName('');
  }, []);

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      <Paper elevation={0} sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', m: 2, overflow: 'hidden' }}>
        <Toolbar
          onUploadClick={handleUploadClick}
          onCreateFolderClick={handleCreateFolderClick}
        />
        <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
          <FileList onDeleteRequest={handleDeleteRequest} />
        </Box>
      </Paper>

      <UploadDialog
        open={uploadDialogOpen}
        onClose={handleUploadDialogClose}
        onUploadComplete={handleUploadComplete}
      />

      <DeleteDialog
        open={deleteDialogOpen}
        item={itemToDelete}
        isDeleting={isDeleting}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />

      <Dialog
        open={createFolderDialogOpen}
        onClose={handleCreateFolderCancel}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Create New Folder</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Folder Name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            margin="normal"
            disabled={isCreatingFolder}
            onKeyPress={(e) => {
              if (e.key === 'Enter' && newFolderName.trim()) {
                void handleCreateFolderConfirm();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCreateFolderCancel} disabled={isCreatingFolder}>
            Cancel
          </Button>
          <Button
            onClick={handleCreateFolderConfirm}
            variant="contained"
            disabled={!newFolderName.trim() || isCreatingFolder}
          >
            {isCreatingFolder ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={handleSnackbarClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={handleSnackbarClose}
          severity={snackbar.severity}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
