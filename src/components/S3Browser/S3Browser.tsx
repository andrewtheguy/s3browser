import { useState, useCallback, useEffect } from 'react';
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
import { PreviewDialog } from '../PreviewDialog';
import { useBrowserContext } from '../../contexts';
import { useDelete, useUpload, usePresignedUrl, useDownload, usePreview } from '../../hooks';
import type { S3Object } from '../../types';

interface SnackbarState {
  open: boolean;
  message: string;
  severity: 'success' | 'error' | 'info' | 'warning';
}

export function S3Browser() {
  const { refresh, currentPath, objects } = useBrowserContext();
  const { remove, removeMany, isDeleting } = useDelete();
  const { createNewFolder } = useUpload();
  const { copyPresignedUrl } = usePresignedUrl();
  const { download } = useDownload();
  const preview = usePreview();

  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [itemsToDelete, setItemsToDelete] = useState<S3Object[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
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

  // Clear selection when path changes
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [currentPath]);

  const handleSelectItem = useCallback((key: string, checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback((checked: boolean) => {
    if (checked) {
      const fileKeys = objects.filter((item) => !item.isFolder).map((item) => item.key);
      setSelectedKeys(new Set(fileKeys));
    } else {
      setSelectedKeys(new Set());
    }
  }, [objects]);

  const handleDeleteRequest = useCallback((item: S3Object) => {
    setItemsToDelete([item]);
    setDeleteDialogOpen(true);
  }, []);

  const handleBatchDeleteRequest = useCallback(() => {
    const items = objects.filter((item) => selectedKeys.has(item.key));
    if (items.length > 0) {
      setItemsToDelete(items);
      setDeleteDialogOpen(true);
    }
  }, [objects, selectedKeys]);

  const handleDeleteConfirm = useCallback(async () => {
    if (itemsToDelete.length === 0) return;

    try {
      if (itemsToDelete.length === 1) {
        const item = itemsToDelete[0];
        await remove(item.key);
        showSnackbar(item.isFolder ? 'Folder deleted successfully' : 'File deleted successfully', 'success');
      } else {
        const keys = itemsToDelete.map((item) => item.key);
        const result = await removeMany(keys);
        if (result.errors.length > 0) {
          showSnackbar(
            `Deleted ${result.deleted.length} files, ${result.errors.length} failed`,
            'warning'
          );
        } else {
          showSnackbar(`${result.deleted.length} files deleted successfully`, 'success');
        }
      }
      setSelectedKeys(new Set());
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      showSnackbar(message, 'error');
    } finally {
      setDeleteDialogOpen(false);
      setItemsToDelete([]);
    }
  }, [itemsToDelete, remove, removeMany, refresh, showSnackbar]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteDialogOpen(false);
    setItemsToDelete([]);
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

  const handleCopyUrl = useCallback(async (key: string) => {
    const success = await copyPresignedUrl(key);
    if (success) {
      showSnackbar('URL copied to clipboard', 'success');
    } else {
      showSnackbar('Failed to copy URL', 'error');
    }
  }, [copyPresignedUrl, showSnackbar]);

  const handlePreview = useCallback((item: S3Object) => {
    void preview.openPreview(item);
  }, [preview]);

  const handlePreviewDownload = useCallback(async (key: string) => {
    try {
      await download(key);
    } catch {
      showSnackbar('Download failed', 'error');
    }
  }, [download, showSnackbar]);

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
          selectedCount={selectedKeys.size}
          onBatchDelete={handleBatchDeleteRequest}
          isDeleting={isDeleting}
        />
        <Box
          sx={{
            flexGrow: 1,
            overflowY: 'scroll',
            overflowX: 'hidden',
            scrollbarGutter: 'stable',
          }}
        >
          <FileList
            onDeleteRequest={handleDeleteRequest}
            onCopyUrl={handleCopyUrl}
            onPreview={handlePreview}
            selectedKeys={selectedKeys}
            onSelectItem={handleSelectItem}
            onSelectAll={handleSelectAll}
          />
        </Box>
      </Paper>

      <UploadDialog
        open={uploadDialogOpen}
        onClose={handleUploadDialogClose}
        onUploadComplete={handleUploadComplete}
      />

      <DeleteDialog
        open={deleteDialogOpen}
        items={itemsToDelete}
        isDeleting={isDeleting}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />

      <PreviewDialog
        open={preview.isOpen}
        isLoading={preview.isLoading}
        error={preview.error}
        content={preview.content}
        item={preview.item}
        cannotPreviewReason={preview.cannotPreviewReason}
        onClose={preview.closePreview}
        onDownload={handlePreviewDownload}
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newFolderName.trim() && !isCreatingFolder) {
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
