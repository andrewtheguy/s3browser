import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
  IconButton,
  Tooltip,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import DeleteIcon from '@mui/icons-material/Delete';
import TouchAppIcon from '@mui/icons-material/TouchApp';
import CloseIcon from '@mui/icons-material/Close';
import { Toolbar } from '../Toolbar';
import { FileList } from '../FileList';
import { UploadDialog } from '../Upload';
import { DeleteDialog } from '../DeleteDialog';
import { PreviewDialog } from '../PreviewDialog';
import { FolderPickerDialog, type FolderPickerResult } from '../FolderPickerDialog';
import { CopyMoveDialog } from '../CopyMoveDialog';
import { useBrowserContext } from '../../contexts';
import { useDelete, useUpload, usePresignedUrl, useDownload, usePreview, useCopyMove } from '../../hooks';
import type { S3Object } from '../../types';
import type { CopyMoveOperation } from '../../services/api/objects';

interface SnackbarState {
  open: boolean;
  message: string;
  severity: 'success' | 'error' | 'info' | 'warning';
}

const DELETE_PREVIEW_LIMIT = 50;

export function S3Browser() {
  const { refresh, currentPath, objects } = useBrowserContext();
  const { remove, removeMany, resolveDeletePlan, isDeleting: isDeletingHook } = useDelete();
  const { createNewFolder } = useUpload();
  const { copyPresignedUrl } = usePresignedUrl();
  const { download } = useDownload();
  const preview = usePreview();
  const {
    copy,
    move,
    copyMany,
    moveMany,
    resolveCopyMovePlan,
    isCopying,
    isMoving,
  } = useCopyMove();

  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [itemsToDelete, setItemsToDelete] = useState<S3Object[]>([]);
  const [deleteMode, setDeleteMode] = useState<'single' | 'batch'>('single');
  const [deletePlan, setDeletePlan] = useState<{ fileKeys: string[]; folderKeys: string[] } | null>(null);
  const [isResolvingDelete, setIsResolvingDelete] = useState(false);
  const [deleteResolveError, setDeleteResolveError] = useState<string | null>(null);
  const [isDeletingBatch, setIsDeletingBatch] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [snackbar, setSnackbar] = useState<SnackbarState>({
    open: false,
    message: '',
    severity: 'success',
  });

  // Copy/Move state
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [copyMoveDialogOpen, setCopyMoveDialogOpen] = useState(false);
  const [copyMoveItem, setCopyMoveItem] = useState<S3Object | null>(null);
  const [copyMoveMode, setCopyMoveMode] = useState<'copy' | 'move'>('copy');
  const [copyMoveDestination, setCopyMoveDestination] = useState('');
  const [copyMovePlan, setCopyMovePlan] = useState<{ operations: CopyMoveOperation[]; folderKeys: string[] } | null>(null);
  const [isResolvingCopyMove, setIsResolvingCopyMove] = useState(false);
  const [copyMoveResolveError, setCopyMoveResolveError] = useState<string | null>(null);
  const [copyMoveProgress, setCopyMoveProgress] = useState<{ completed: number; total: number } | undefined>(undefined);
  const [copyMoveNewName, setCopyMoveNewName] = useState('');

  const showSnackbar = useCallback(
    (message: string, severity: SnackbarState['severity']) => {
      setSnackbar({ open: true, message, severity });
    },
    []
  );

  const isDeleting = isDeletingBatch || isDeletingHook;

  const deletePreview = useMemo(() => {
    if (deleteMode !== 'batch' || !deletePlan) {
      return null;
    }
    const sortedKeys = [...deletePlan.fileKeys].sort((a, b) => a.localeCompare(b));
    return {
      previewKeys: sortedKeys.slice(0, DELETE_PREVIEW_LIMIT),
      totalKeys: sortedKeys.length,
      folderCount: deletePlan.folderKeys.length,
    };
  }, [deleteMode, deletePlan]);

  const itemsToDeleteKey = useMemo(() => {
    if (itemsToDelete.length === 0) {
      return '';
    }
    return itemsToDelete
      .map((item) => item.key)
      .sort((a, b) => a.localeCompare(b))
      .join('|');
  }, [itemsToDelete]);

  const itemsToDeleteRef = useRef<S3Object[]>([]);

  useEffect(() => {
    itemsToDeleteRef.current = itemsToDelete;
  }, [itemsToDelete]);

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
      const keys = objects.map((item) => item.key);
      setSelectedKeys(new Set(keys));
    } else {
      setSelectedKeys(new Set());
    }
  }, [objects]);

  const handleToggleSelection = useCallback(() => {
    setSelectionMode((prev) => {
      const next = !prev;
      if (!next) {
        setSelectedKeys(new Set());
      }
      return next;
    });
  }, []);

  const handleDeleteRequest = useCallback((item: S3Object) => {
    setDeleteMode(item.isFolder ? 'batch' : 'single');
    setItemsToDelete([item]);
    setDeletePlan(null);
    setDeleteResolveError(null);
    setDeleteDialogOpen(true);
  }, []);

  const handleBatchDeleteRequest = useCallback(() => {
    const items = objects.filter((item) => selectedKeys.has(item.key));
    if (items.length > 0) {
      setDeleteMode('batch');
      setItemsToDelete(items);
      setDeletePlan(null);
      setDeleteResolveError(null);
      setDeleteDialogOpen(true);
    }
  }, [objects, selectedKeys]);

  useEffect(() => {
    if (!deleteDialogOpen || deleteMode !== 'batch') {
      setDeletePlan(null);
      setIsResolvingDelete(false);
      setDeleteResolveError(null);
      return;
    }

    const abortController = new AbortController();
    setIsResolvingDelete(true);
    setDeleteResolveError(null);

    void (async () => {
      try {
        const plan = await resolveDeletePlan(itemsToDeleteRef.current, {
          includeFolderContents: true,
          signal: abortController.signal,
        });
        if (!abortController.signal.aborted) {
          setDeletePlan(plan);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          const message = err instanceof Error ? err.message : 'Failed to list items for deletion';
          setDeleteResolveError(message);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setIsResolvingDelete(false);
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [deleteDialogOpen, deleteMode, itemsToDeleteKey, resolveDeletePlan]);

  const handleDeleteConfirm = useCallback(async () => {
    if (itemsToDelete.length === 0) return;
    if (deleteMode === 'batch' && !deletePlan) {
      showSnackbar('Delete list is still loading', 'warning');
      return;
    }

    setIsDeletingBatch(true);
    try {
      if (deleteMode === 'single') {
        const item = itemsToDelete[0];
        await remove(item.key);
        showSnackbar(item.isFolder ? 'Folder deleted successfully' : 'File deleted successfully', 'success');
      } else {
        const plan = deletePlan ?? { fileKeys: [], folderKeys: [] };
        const result = await removeMany(plan.fileKeys);

        let folderFailures = 0;
        const orderedFolders = [...plan.folderKeys].sort((a, b) => b.length - a.length);
        for (const folderKey of orderedFolders) {
          try {
            await remove(folderKey);
          } catch {
            folderFailures += 1;
          }
        }

        const folderRemoved = plan.folderKeys.length - folderFailures;
        const hasFileFailures = result.errors.length > 0;
        const hasFolderFailures = folderFailures > 0;

        if (hasFileFailures || hasFolderFailures) {
          const parts: string[] = [];
          if (plan.fileKeys.length > 0) {
            parts.push(`Deleted ${result.deleted.length} files, ${result.errors.length} failed`);
          }
          if (plan.folderKeys.length > 0) {
            parts.push(hasFolderFailures
              ? `Removed ${folderRemoved} folders, ${folderFailures} failed`
              : `${folderRemoved} folders removed`);
          }
          showSnackbar(parts.join('. '), 'warning');
        } else {
          const parts: string[] = [];
          if (plan.fileKeys.length > 0) {
            parts.push(`${result.deleted.length} files deleted`);
          }
          if (plan.folderKeys.length > 0) {
            parts.push(`${folderRemoved} folders removed`);
          }
          showSnackbar(parts.length > 0 ? parts.join('. ') : 'Nothing to delete', 'success');
        }
      }
      setSelectedKeys(new Set());
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      showSnackbar(message, 'error');
    } finally {
      setIsDeletingBatch(false);
      setDeleteDialogOpen(false);
      setItemsToDelete([]);
      setDeletePlan(null);
      setDeleteResolveError(null);
    }
  }, [itemsToDelete, deleteMode, deletePlan, remove, removeMany, refresh, showSnackbar]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteDialogOpen(false);
    setItemsToDelete([]);
    setDeletePlan(null);
    setDeleteResolveError(null);
    setDeleteMode('single');
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

  const { openPreview } = preview;
  const handlePreview = useCallback((item: S3Object) => {
    void openPreview(item);
  }, [openPreview]);

  const handlePreviewDownload = useCallback(async (key: string) => {
    try {
      await download(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showSnackbar(message || 'Download failed', 'error');
    }
  }, [download, showSnackbar]);

  // Copy/Move handlers
  const handleCopyRequest = useCallback((item: S3Object) => {
    setCopyMoveItem(item);
    setCopyMoveMode('copy');
    setFolderPickerOpen(true);
  }, []);

  const handleMoveRequest = useCallback((item: S3Object) => {
    setCopyMoveItem(item);
    setCopyMoveMode('move');
    setFolderPickerOpen(true);
  }, []);

  const handleFolderPickerCancel = useCallback(() => {
    setFolderPickerOpen(false);
    setCopyMoveItem(null);
  }, []);

  const handleDestinationSelected = useCallback((result: FolderPickerResult) => {
    setFolderPickerOpen(false);
    setCopyMoveDestination(result.destinationPath);
    setCopyMoveNewName(result.newName);
    setCopyMovePlan(null);
    setCopyMoveResolveError(null);
    setCopyMoveProgress(undefined);
    setCopyMoveDialogOpen(true);
  }, []);

  // Resolve copy/move plan when dialog opens
  useEffect(() => {
    if (!copyMoveDialogOpen || !copyMoveItem) {
      setCopyMovePlan(null);
      setIsResolvingCopyMove(false);
      setCopyMoveResolveError(null);
      return;
    }

    const abortController = new AbortController();

    if (copyMoveItem.isFolder) {
      setIsResolvingCopyMove(true);
      setCopyMoveResolveError(null);

      void (async () => {
        try {
          const plan = await resolveCopyMovePlan(copyMoveItem, copyMoveDestination, {
            signal: abortController.signal,
            newName: copyMoveNewName,
          });
          if (!abortController.signal.aborted) {
            setCopyMovePlan(plan);
          }
        } catch (err) {
          if (!abortController.signal.aborted) {
            const message = err instanceof Error ? err.message : 'Failed to list items';
            setCopyMoveResolveError(message);
          }
        } finally {
          if (!abortController.signal.aborted) {
            setIsResolvingCopyMove(false);
          }
        }
      })();
    } else {
      // For single files, create a simple plan using the new name
      // Normalize: treat '/' as root (empty string), strip leading slashes
      let normalizedDest = copyMoveDestination === '/' ? '' : copyMoveDestination;
      normalizedDest = normalizedDest.replace(/^\/+/, '').replace(/\/+$/, '');
      if (normalizedDest) {
        normalizedDest = normalizedDest + '/';
      }

      // Strip leading slashes from name
      let normalizedName = copyMoveNewName.replace(/^\/+/, '');

      // If name is empty, fallback to basename of source key
      if (!normalizedName) {
        const sourceBasename = copyMoveItem.key.split('/').filter(Boolean).pop();
        if (!sourceBasename) {
          setCopyMoveResolveError('Invalid source key: cannot determine filename');
          return;
        }
        normalizedName = sourceBasename;
      }

      // Build destination key and collapse any duplicate slashes
      const destinationKey = (normalizedDest + normalizedName).replace(/\/+/g, '/');

      // Final validation: destinationKey should not be empty or start with '/'
      if (!destinationKey || destinationKey.startsWith('/')) {
        setCopyMoveResolveError('Invalid destination: path cannot be empty or start with /');
        return;
      }

      setCopyMovePlan({
        operations: [{
          sourceKey: copyMoveItem.key,
          destinationKey,
        }],
        folderKeys: [],
      });
    }

    return () => {
      abortController.abort();
    };
  }, [copyMoveDialogOpen, copyMoveItem, copyMoveDestination, copyMoveNewName, resolveCopyMovePlan]);

  const handleCopyMoveConfirm = useCallback(async () => {
    if (!copyMoveItem || !copyMovePlan) return;

    setCopyMoveProgress({ completed: 0, total: copyMovePlan.operations.length });

    try {
      if (copyMoveItem.isFolder) {
        // Batch operation for folders
        const executeOp = copyMoveMode === 'copy' ? copyMany : moveMany;
        const result = await executeOp(copyMovePlan.operations);

        setCopyMoveProgress({ completed: result.successful.length, total: copyMovePlan.operations.length });

        if (result.errors.length > 0) {
          showSnackbar(
            `${copyMoveMode === 'copy' ? 'Copied' : 'Moved'} ${result.successful.length} objects, ${result.errors.length} failed`,
            'warning'
          );
        } else {
          showSnackbar(
            `${copyMoveMode === 'copy' ? 'Copied' : 'Moved'} ${result.successful.length} objects successfully`,
            'success'
          );
        }
      } else {
        // Single file operation
        const op = copyMovePlan.operations[0];
        if (copyMoveMode === 'copy') {
          await copy(op.sourceKey, op.destinationKey);
        } else {
          await move(op.sourceKey, op.destinationKey);
        }
        setCopyMoveProgress({ completed: 1, total: 1 });
        showSnackbar(
          `File ${copyMoveMode === 'copy' ? 'copied' : 'moved'} successfully`,
          'success'
        );
      }

      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : `${copyMoveMode === 'copy' ? 'Copy' : 'Move'} failed`;
      showSnackbar(message, 'error');
    } finally {
      setCopyMoveDialogOpen(false);
      setCopyMoveItem(null);
      setCopyMovePlan(null);
      setCopyMoveProgress(undefined);
      setCopyMoveNewName('');
    }
  }, [copyMoveItem, copyMovePlan, copyMoveMode, copy, move, copyMany, moveMany, refresh, showSnackbar]);

  const handleCopyMoveCancel = useCallback(() => {
    setCopyMoveDialogOpen(false);
    setCopyMoveItem(null);
    setCopyMoveDestination('');
    setCopyMovePlan(null);
    setCopyMoveResolveError(null);
    setCopyMoveProgress(undefined);
    setCopyMoveNewName('');
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
          selectedCount={selectedKeys.size}
          onBatchDelete={handleBatchDeleteRequest}
          isDeleting={isDeleting}
          selectionMode={selectionMode}
          onToggleSelection={handleToggleSelection}
        />
        <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Box
            sx={{
              flexGrow: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              scrollbarGutter: 'stable',
              minHeight: 0,
            }}
          >
            <FileList
              onDeleteRequest={handleDeleteRequest}
              onCopyRequest={handleCopyRequest}
              onMoveRequest={handleMoveRequest}
              onCopyUrl={handleCopyUrl}
              onPreview={handlePreview}
              selectedKeys={selectedKeys}
              onSelectItem={handleSelectItem}
              onSelectAll={handleSelectAll}
              selectionMode={selectionMode}
            />
          </Box>
          <Box
            sx={{
              display: { xs: 'flex', sm: 'none' },
              flexWrap: 'wrap',
              gap: 1,
              justifyContent: 'flex-start',
              p: 1,
              borderTop: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
            }}
          >
            <Tooltip title={selectionMode ? 'Cancel selection' : 'Select items'}>
              <IconButton onClick={handleToggleSelection} color={selectionMode ? 'primary' : 'default'}>
                {selectionMode ? <CloseIcon /> : <TouchAppIcon />}
              </IconButton>
            </Tooltip>
            {selectionMode && selectedKeys.size > 0 && (
              <Tooltip title={isDeleting ? 'Deleting...' : `Delete (${selectedKeys.size})`}>
                <span>
                  <IconButton onClick={handleBatchDeleteRequest} disabled={isDeleting} color="error">
                    <DeleteIcon />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            <Tooltip title="New Folder">
              <IconButton onClick={handleCreateFolderClick} color="default">
                <CreateNewFolderIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Upload">
              <IconButton onClick={handleUploadClick} color="primary">
                <CloudUploadIcon />
              </IconButton>
            </Tooltip>
          </Box>
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
        isResolving={isResolvingDelete}
        previewKeys={deletePreview?.previewKeys}
        totalKeys={deletePreview?.totalKeys}
        folderCount={deletePreview?.folderCount}
        isBatch={deleteMode === 'batch'}
        resolutionError={deleteResolveError}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />

      <PreviewDialog
        open={preview.isOpen}
        isLoading={preview.isLoading}
        error={preview.error}
        signedUrl={preview.signedUrl}
        embedType={preview.embedType}
        item={preview.item}
        cannotPreviewReason={preview.cannotPreviewReason}
        onClose={preview.closePreview}
        onDownload={handlePreviewDownload}
      />

      <FolderPickerDialog
        open={folderPickerOpen}
        title={copyMoveMode === 'copy' ? 'Copy to...' : 'Move to...'}
        sourceItem={copyMoveItem}
        currentSourcePath={currentPath}
        mode={copyMoveMode}
        onConfirm={handleDestinationSelected}
        onCancel={handleFolderPickerCancel}
      />

      <CopyMoveDialog
        open={copyMoveDialogOpen}
        mode={copyMoveMode}
        sourceItem={copyMoveItem}
        destinationPath={copyMoveDestination}
        newName={copyMoveNewName}
        isResolving={isResolvingCopyMove}
        isExecuting={isCopying || isMoving}
        resolutionError={copyMoveResolveError}
        plan={copyMovePlan}
        progress={copyMoveProgress}
        onConfirm={handleCopyMoveConfirm}
        onCancel={handleCopyMoveCancel}
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
