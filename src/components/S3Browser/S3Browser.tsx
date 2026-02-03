import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Upload,
  FolderPlus,
  Trash2,
  Hand,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Toolbar } from '../Toolbar';
import { FileList } from '../FileList';
import { UploadDialog } from '../Upload';
import { DeleteDialog } from '../DeleteDialog';
import { PreviewDialog } from '../PreviewDialog';
import { FolderPickerDialog, type FolderPickerResult } from '../FolderPickerDialog';
import { CopyMoveDialog } from '../CopyMoveDialog';
import { BucketInfoDialog } from '../BucketInfoDialog';
import { useBrowserContext } from '../../contexts';
import { useDelete, useUpload, usePresignedUrl, useDownload, usePreview, useCopyMove, useSeedTestItems } from '../../hooks';
import { FEATURES } from '../../config';
import type { S3Object } from '../../types';
import type { CopyMoveOperation } from '../../services/api/objects';

const DELETE_PREVIEW_LIMIT = 100;
const DELETE_CONTINUATION_START_AT = 500;
const DELETE_CONTINUATION_EVERY = 10_000;

export function S3Browser() {
  const { refresh, currentPath, objects } = useBrowserContext();
  const { remove, removeMany, resolveDeletePlan, isDeleting: isDeletingHook } = useDelete();
  const { createNewFolder } = useUpload();
  const { copyPresignedUrl, copyS3Uri } = usePresignedUrl();
  const { download } = useDownload();
  const preview = usePreview();
  const { seedTestItems } = useSeedTestItems();
  const seedTestItemsEnabled = FEATURES.seedTestItems;
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
  const [deleteContinuationCount, setDeleteContinuationCount] = useState<number | null>(null);
  const deleteContinuationResolveRef = useRef<((value: boolean) => void) | null>(null);
  const deleteResolveAbortRef = useRef<AbortController | null>(null);
  const [isDeletingBatch, setIsDeletingBatch] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);

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
  const [isSeedingTestItems, setIsSeedingTestItems] = useState(false);

  // Bucket info state
  const [bucketInfoOpen, setBucketInfoOpen] = useState(false);

  const handleBucketInfoClick = useCallback(() => {
    setBucketInfoOpen(true);
  }, []);

  const handleBucketInfoClose = useCallback(() => {
    setBucketInfoOpen(false);
  }, []);

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

  const deleteSelectionAllFiles = useMemo(() => {
    if (itemsToDelete.length === 0) {
      return false;
    }
    return itemsToDelete.every((item) => !item.isFolder);
  }, [itemsToDelete]);

  const itemsToDeleteRef = useRef<S3Object[]>([]);

  useEffect(() => {
    itemsToDeleteRef.current = itemsToDelete;
  }, [itemsToDelete]);

  const handleUploadClick = useCallback(() => {
    setUploadDialogOpen(true);
  }, []);

  const handleUploadDialogClose = useCallback(() => {
    setUploadDialogOpen(false);
  }, []);

  const handleUploadComplete = useCallback(() => {
    void refresh();
    toast.success('Files uploaded successfully');
  }, [refresh]);

  const handleSeedTestItems = useCallback(async () => {
    if (!seedTestItemsEnabled) return;
    if (isSeedingTestItems) return;

    const input = window.prompt('Folder name for test items', 'seed-10005');
    if (!input) return;
    const trimmed = input.trim();
    if (!trimmed) return;

    const targetPrefix = `${currentPath}${trimmed}`;
    const confirmed = window.confirm(`Create 10,005 items in "${targetPrefix}/"?`);
    if (!confirmed) return;

    setIsSeedingTestItems(true);
    try {
      const result = await seedTestItems(targetPrefix);
      toast.success(`Created ${result.created} items in ${result.prefix}`);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create test items';
      toast.error(message);
    } finally {
      setIsSeedingTestItems(false);
    }
  }, [currentPath, isSeedingTestItems, refresh, seedTestItems, seedTestItemsEnabled]);

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

    if (deleteSelectionAllFiles) {
      if (deleteResolveAbortRef.current) {
        deleteResolveAbortRef.current.abort();
        deleteResolveAbortRef.current = null;
      }
      setDeletePlan({
        fileKeys: itemsToDeleteRef.current.map((item) => item.key),
        folderKeys: [],
      });
      setIsResolvingDelete(false);
      setDeleteResolveError(null);
      setDeleteContinuationCount(null);
      return;
    }

    const abortController = new AbortController();
    deleteResolveAbortRef.current = abortController;
    setIsResolvingDelete(true);
    setDeleteResolveError(null);

    void (async () => {
      try {
        const folderSelection = itemsToDeleteRef.current.some((item) => item.isFolder);
        const plan = await resolveDeletePlan(itemsToDeleteRef.current, {
          includeFolderContents: true,
          signal: abortController.signal,
          continuationPromptStartAt: folderSelection ? DELETE_CONTINUATION_START_AT : undefined,
          continuationPromptEvery: folderSelection ? DELETE_CONTINUATION_EVERY : undefined,
          onContinuationPrompt: (currentCount) =>
            new Promise<boolean>((resolve) => {
              deleteContinuationResolveRef.current = resolve;
              setDeleteContinuationCount(currentCount);
            }),
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
      deleteResolveAbortRef.current = null;
      if (deleteContinuationResolveRef.current) {
        deleteContinuationResolveRef.current(false);
        deleteContinuationResolveRef.current = null;
      }
      setDeleteContinuationCount(null);
    };
  }, [deleteDialogOpen, deleteMode, itemsToDeleteKey, deleteSelectionAllFiles, resolveDeletePlan]);

  const handleDeleteConfirm = useCallback(async () => {
    if (itemsToDelete.length === 0) return;
    if (deleteMode === 'batch' && !deletePlan) {
      toast.warning('Delete list is still loading');
      return;
    }

    setIsDeletingBatch(true);
    try {
      if (deleteMode === 'single') {
        const item = itemsToDelete[0];
        await remove(item.key);
        toast.success(item.isFolder ? 'Folder deleted successfully' : 'File deleted successfully');
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
          toast.warning(parts.join('. '));
        } else {
          const parts: string[] = [];
          if (plan.fileKeys.length > 0) {
            parts.push(`${result.deleted.length} files deleted`);
          }
          if (plan.folderKeys.length > 0) {
            parts.push(`${folderRemoved} folders removed`);
          }
          toast.success(parts.length > 0 ? parts.join('. ') : 'Nothing to delete');
        }
      }
      setSelectedKeys(new Set());
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      toast.error(message);
    } finally {
      setIsDeletingBatch(false);
      setDeleteDialogOpen(false);
      setItemsToDelete([]);
      setDeletePlan(null);
      setDeleteResolveError(null);
    }
  }, [itemsToDelete, deleteMode, deletePlan, remove, removeMany, refresh]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteDialogOpen(false);
    setItemsToDelete([]);
    setDeletePlan(null);
    setDeleteResolveError(null);
    setDeleteMode('single');
    if (deleteContinuationResolveRef.current) {
      deleteContinuationResolveRef.current(false);
      deleteContinuationResolveRef.current = null;
    }
    setDeleteContinuationCount(null);
  }, []);

  const handleDeleteContinuationCancel = useCallback(() => {
    if (deleteResolveAbortRef.current) {
      deleteResolveAbortRef.current.abort();
      deleteResolveAbortRef.current = null;
    }
    handleDeleteCancel();
  }, [handleDeleteCancel]);

  const handleDeleteContinuationConfirm = useCallback(() => {
    if (deleteContinuationResolveRef.current) {
      deleteContinuationResolveRef.current(true);
      deleteContinuationResolveRef.current = null;
    }
    setDeleteContinuationCount(null);
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
      toast.success('Folder created successfully');
      await refresh();
      setCreateFolderDialogOpen(false);
      setNewFolderName('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create folder';
      toast.error(message);
    } finally {
      setIsCreatingFolder(false);
    }
  }, [newFolderName, currentPath, createNewFolder, refresh]);

  const handleCreateFolderCancel = useCallback(() => {
    setCreateFolderDialogOpen(false);
    setNewFolderName('');
  }, []);

  const formatTtlDuration = (ttl: number): string => {
    const days = Math.floor(ttl / 86400);
    const hours = Math.floor((ttl % 86400) / 3600);
    const minutes = Math.floor((ttl % 3600) / 60);

    if (days > 0) {
      return days === 1 ? '1 day' : `${days} days`;
    }
    if (hours > 0) {
      return hours === 1 ? '1 hour' : `${hours} hours`;
    }
    if (minutes > 0) {
      return minutes === 1 ? '1 minute' : `${minutes} minutes`;
    }
    return `${ttl} seconds`;
  };

  const handleCopyUrl = useCallback(async (key: string, ttl: number) => {
    const result = await copyPresignedUrl(key, ttl);
    if (result.success) {
      const duration = formatTtlDuration(ttl);
      toast.success(`Presigned URL (${duration}) copied to clipboard`);
    } else {
      toast.error('Failed to copy URL');
    }
  }, [copyPresignedUrl]);

  const handleCopyS3Uri = useCallback(async (key: string) => {
    const result = await copyS3Uri(key);
    if (result.success) {
      toast.success('S3 URI copied to clipboard');
    } else {
      toast.error('Failed to copy S3 URI');
    }
  }, [copyS3Uri]);

  const { openPreview } = preview;
  const handlePreview = useCallback((item: S3Object) => {
    void openPreview(item);
  }, [openPreview]);

  const handlePreviewDownload = useCallback(async (key: string) => {
    try {
      await download(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message || 'Download failed');
    }
  }, [download]);

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
          toast.warning(
            `${copyMoveMode === 'copy' ? 'Copied' : 'Moved'} ${result.successful.length} objects, ${result.errors.length} failed`
          );
        } else {
          toast.success(
            `${copyMoveMode === 'copy' ? 'Copied' : 'Moved'} ${result.successful.length} objects successfully`
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
        toast.success(
          `File ${copyMoveMode === 'copy' ? 'copied' : 'moved'} successfully`
        );
      }

      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : `${copyMoveMode === 'copy' ? 'Copy' : 'Move'} failed`;
      toast.error(message);
    } finally {
      setCopyMoveDialogOpen(false);
      setCopyMoveItem(null);
      setCopyMovePlan(null);
      setCopyMoveProgress(undefined);
      setCopyMoveNewName('');
    }
  }, [copyMoveItem, copyMovePlan, copyMoveMode, copy, move, copyMany, moveMany, refresh]);

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
    <div className="h-screen flex flex-col bg-background">
      <div className="flex-1 flex flex-col m-4 bg-card rounded-lg border shadow-sm overflow-hidden">
        <Toolbar
          onUploadClick={handleUploadClick}
          onCreateFolderClick={handleCreateFolderClick}
          onBucketInfoClick={handleBucketInfoClick}
          selectedCount={selectedKeys.size}
          onBatchDelete={handleBatchDeleteRequest}
          isDeleting={isDeleting}
          selectionMode={selectionMode}
          onToggleSelection={handleToggleSelection}
          onSeedTestItems={seedTestItemsEnabled ? handleSeedTestItems : undefined}
          isSeedingTestItems={seedTestItemsEnabled ? isSeedingTestItems : undefined}
        />
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
            <FileList
              onDeleteRequest={handleDeleteRequest}
              onCopyRequest={handleCopyRequest}
              onMoveRequest={handleMoveRequest}
              onCopyUrl={handleCopyUrl}
              onCopyS3Uri={handleCopyS3Uri}
              onPreview={handlePreview}
              selectedKeys={selectedKeys}
              onSelectItem={handleSelectItem}
              onSelectAll={handleSelectAll}
              selectionMode={selectionMode}
            />
          </div>
          <TooltipProvider>
            <div className="flex sm:hidden flex-wrap gap-2 justify-start p-2 border-t bg-card">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={selectionMode ? 'default' : 'ghost'}
                    size="icon"
                    onClick={handleToggleSelection}
                  >
                    {selectionMode ? <X className="h-4 w-4" /> : <Hand className="h-4 w-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {selectionMode ? 'Cancel selection' : 'Select items'}
                </TooltipContent>
              </Tooltip>
              {selectionMode && selectedKeys.size > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleBatchDeleteRequest}
                      disabled={isDeleting}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isDeleting ? 'Deleting...' : `Delete (${selectedKeys.size})`}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={handleCreateFolderClick}>
                    <FolderPlus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New Folder</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="default" size="icon" onClick={handleUploadClick}>
                    <Upload className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Upload</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>
      </div>

      {uploadDialogOpen && (
        <UploadDialog
          open={uploadDialogOpen}
          onClose={handleUploadDialogClose}
          onUploadComplete={handleUploadComplete}
        />
      )}

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

      <Dialog open={deleteContinuationCount !== null} onOpenChange={(open) => !open && handleDeleteContinuationCancel()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Continue gathering deletes?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Found {deleteContinuationCount ?? 0} objects so far. Continue gathering more to delete?
            </p>
            <p className="text-xs text-muted-foreground">
              Stopping will cancel the delete.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleDeleteContinuationCancel}>
              Stop
            </Button>
            <Button onClick={handleDeleteContinuationConfirm}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <Dialog open={createFolderDialogOpen} onOpenChange={(open) => !open && handleCreateFolderCancel()}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Create New Folder</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="folderName">Folder Name</Label>
              <Input
                id="folderName"
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                disabled={isCreatingFolder}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newFolderName.trim() && !isCreatingFolder) {
                    void handleCreateFolderConfirm();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCreateFolderCancel} disabled={isCreatingFolder}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateFolderConfirm}
              disabled={!newFolderName.trim() || isCreatingFolder}
            >
              {isCreatingFolder ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BucketInfoDialog open={bucketInfoOpen} onClose={handleBucketInfoClose} />
    </div>
  );
}
