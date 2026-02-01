import { useState, useCallback, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  TextField,
  Box,
  Breadcrumbs,
  Link,
  Typography,
  CircularProgress,
  Alert,
  IconButton,
  Tooltip,
  InputAdornment,
} from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import HomeIcon from '@mui/icons-material/Home';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { useS3ClientContext } from '../../contexts';
import { useParams } from 'react-router';
import { listObjects, createFolder } from '../../services/api';
import type { S3Object } from '../../types';

interface FolderPickerDialogProps {
  open: boolean;
  title: string;
  sourceItem: S3Object | null;
  currentSourcePath: string;
  mode: 'copy' | 'move';
  onConfirm: (destinationPath: string) => void;
  onCancel: () => void;
}

export function FolderPickerDialog({
  open,
  title,
  sourceItem,
  currentSourcePath,
  mode,
  onConfirm,
  onCancel,
}: FolderPickerDialogProps) {
  const { activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;

  const [browsePath, setBrowsePath] = useState('');
  const [folders, setFolders] = useState<S3Object[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [isManualInput, setIsManualInput] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setBrowsePath('');
      setManualPath('');
      setIsManualInput(false);
      setShowNewFolderInput(false);
      setNewFolderName('');
      setError(null);
    }
  }, [open]);

  // Load folders when path changes
  useEffect(() => {
    if (!open || !activeConnectionId || !bucket) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await listObjects(
          activeConnectionId,
          bucket,
          browsePath,
          undefined,
          controller.signal
        );
        const folderList = result.objects.filter((obj) => obj.isFolder);
        setFolders(folderList);
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setError(err.message);
        }
      } finally {
        setIsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [open, browsePath, activeConnectionId, bucket]);

  const handleFolderClick = useCallback((folderKey: string) => {
    setBrowsePath(folderKey);
  }, []);

  const handleBreadcrumbClick = useCallback((index: number) => {
    const segments = browsePath.split('/').filter(Boolean);
    const newPath = segments.slice(0, index).join('/');
    setBrowsePath(newPath ? newPath + '/' : '');
  }, [browsePath]);

  const handleGoUp = useCallback(() => {
    const segments = browsePath.split('/').filter(Boolean);
    if (segments.length > 0) {
      const newPath = segments.slice(0, -1).join('/');
      setBrowsePath(newPath ? newPath + '/' : '');
    }
  }, [browsePath]);

  const handleConfirm = useCallback(() => {
    const finalPath = isManualInput ? manualPath : browsePath;
    // Ensure path ends with / if not empty
    const normalizedPath = finalPath && !finalPath.endsWith('/') ? finalPath + '/' : finalPath;
    onConfirm(normalizedPath);
  }, [isManualInput, manualPath, browsePath, onConfirm]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !activeConnectionId || !bucket) return;

    setIsCreatingFolder(true);
    try {
      const fullPath = browsePath + newFolderName.trim();
      await createFolder(activeConnectionId, bucket, fullPath);
      // Refresh folder list
      const result = await listObjects(activeConnectionId, bucket, browsePath);
      setFolders(result.objects.filter((obj) => obj.isFolder));
      setNewFolderName('');
      setShowNewFolderInput(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setIsCreatingFolder(false);
    }
  }, [newFolderName, browsePath, activeConnectionId, bucket]);

  const toggleManualInput = useCallback(() => {
    if (!isManualInput) {
      setManualPath(browsePath);
    }
    setIsManualInput(!isManualInput);
  }, [isManualInput, browsePath]);

  // Check if destination is invalid (same as source or subfolder of source for move)
  const isInvalidDestination = useCallback((): string | null => {
    if (!sourceItem) return null;

    const destPath = isManualInput ? manualPath : browsePath;
    const normalizedDest = destPath.endsWith('/') ? destPath : destPath + '/';

    // For move operations, can't move a folder into itself or its subfolders
    if (mode === 'move' && sourceItem.isFolder) {
      const sourcePrefix = sourceItem.key;
      if (normalizedDest.startsWith(sourcePrefix)) {
        return 'Cannot move a folder into itself';
      }
    }

    // Can't copy/move to the same location
    if (normalizedDest === currentSourcePath) {
      return 'Destination is the same as current location';
    }

    return null;
  }, [sourceItem, isManualInput, manualPath, browsePath, mode, currentSourcePath]);

  const validationError = isInvalidDestination();
  const pathSegments = browsePath.split('/').filter(Boolean);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { minHeight: 400, maxHeight: '80vh' } }}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', p: 0 }}>
        {/* Breadcrumb navigation */}
        <Box sx={{ px: 3, py: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Tooltip title="Go up">
              <span>
                <IconButton
                  size="small"
                  onClick={handleGoUp}
                  disabled={browsePath === '' || isManualInput}
                >
                  <ArrowBackIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Breadcrumbs sx={{ flex: 1, minWidth: 0 }}>
              <Link
                component="button"
                variant="body2"
                onClick={() => handleBreadcrumbClick(0)}
                underline="hover"
                color={pathSegments.length === 0 ? 'text.primary' : 'inherit'}
                sx={{ display: 'flex', alignItems: 'center' }}
                disabled={isManualInput}
              >
                <HomeIcon sx={{ mr: 0.5, fontSize: 18 }} />
                Root
              </Link>
              {pathSegments.map((segment, index) => (
                <Link
                  key={index}
                  component="button"
                  variant="body2"
                  onClick={() => handleBreadcrumbClick(index + 1)}
                  underline="hover"
                  color={index === pathSegments.length - 1 ? 'text.primary' : 'inherit'}
                  disabled={isManualInput}
                  sx={{
                    maxWidth: 120,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {segment}
                </Link>
              ))}
            </Breadcrumbs>
            <Tooltip title={isManualInput ? 'Browse folders' : 'Enter path manually'}>
              <IconButton size="small" onClick={toggleManualInput}>
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        {/* Manual path input */}
        {isManualInput && (
          <Box sx={{ px: 3, py: 2, borderBottom: 1, borderColor: 'divider' }}>
            <TextField
              fullWidth
              size="small"
              label="Destination path"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              placeholder="Enter folder path (e.g., folder/subfolder/)"
              helperText="Leave empty for root"
            />
          </Box>
        )}

        {/* Error alert */}
        {error && (
          <Alert severity="error" sx={{ mx: 3, mt: 2 }}>
            {error}
          </Alert>
        )}

        {/* Validation error */}
        {validationError && (
          <Alert severity="warning" sx={{ mx: 3, mt: 2 }}>
            {validationError}
          </Alert>
        )}

        {/* Folder list */}
        {!isManualInput && (
          <Box sx={{ flex: 1, overflow: 'auto', minHeight: 200 }}>
            {isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress size={32} />
              </Box>
            ) : folders.length === 0 ? (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ textAlign: 'center', py: 4 }}
              >
                No subfolders in this location
              </Typography>
            ) : (
              <List dense>
                {folders.map((folder) => (
                  <ListItemButton
                    key={folder.key}
                    onClick={() => handleFolderClick(folder.key)}
                  >
                    <ListItemIcon sx={{ minWidth: 40 }}>
                      <FolderIcon sx={{ color: '#f9a825' }} />
                    </ListItemIcon>
                    <ListItemText
                      primary={folder.name}
                      primaryTypographyProps={{
                        noWrap: true,
                        sx: { maxWidth: 300 },
                      }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Box>
        )}

        {/* Create new folder */}
        {!isManualInput && (
          <Box sx={{ px: 3, py: 2, borderTop: 1, borderColor: 'divider' }}>
            {showNewFolderInput ? (
              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField
                  size="small"
                  fullWidth
                  placeholder="New folder name"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  disabled={isCreatingFolder}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newFolderName.trim()) {
                      void handleCreateFolder();
                    } else if (e.key === 'Escape') {
                      setShowNewFolderInput(false);
                      setNewFolderName('');
                    }
                  }}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          size="small"
                          onClick={handleCreateFolder}
                          disabled={!newFolderName.trim() || isCreatingFolder}
                        >
                          {isCreatingFolder ? (
                            <CircularProgress size={16} />
                          ) : (
                            <CheckIcon fontSize="small" />
                          )}
                        </IconButton>
                        <IconButton
                          size="small"
                          onClick={() => {
                            setShowNewFolderInput(false);
                            setNewFolderName('');
                          }}
                          disabled={isCreatingFolder}
                        >
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </InputAdornment>
                    ),
                  }}
                />
              </Box>
            ) : (
              <Button
                startIcon={<CreateNewFolderIcon />}
                onClick={() => setShowNewFolderInput(true)}
                size="small"
              >
                Create New Folder
              </Button>
            )}
          </Box>
        )}

        {/* Current selection display */}
        <Box sx={{ px: 3, py: 1, bgcolor: 'action.hover' }}>
          <Typography variant="caption" color="text.secondary">
            {mode === 'copy' ? 'Copy' : 'Move'} to:{' '}
            <strong>
              {(isManualInput ? manualPath : browsePath) || '/ (root)'}
            </strong>
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          disabled={!!validationError}
        >
          {mode === 'copy' ? 'Copy Here' : 'Move Here'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
