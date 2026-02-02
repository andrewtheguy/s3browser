import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Folder,
  FolderPlus,
  Home,
  ArrowLeft,
  Pencil,
  Check,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useS3ClientContext } from '../../contexts';
import { useParams } from 'react-router';
import { listObjects, createFolder } from '../../services/api';
import type { S3Object } from '../../types';

export interface FolderPickerResult {
  destinationPath: string;
  newName: string;
}

interface FolderPickerDialogProps {
  open: boolean;
  title: string;
  sourceItem: S3Object | null;
  currentSourcePath: string;
  mode: 'copy' | 'move';
  onConfirm: (result: FolderPickerResult) => void;
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
  const [newName, setNewName] = useState('');

  // Ref for aborting create folder listObjects call
  const createFolderControllerRef = useRef<AbortController | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open && sourceItem) {
      // Default to current directory
      setBrowsePath(currentSourcePath);
      setManualPath(currentSourcePath);
      setIsManualInput(false);
      setShowNewFolderInput(false);
      setNewFolderName('');
      setError(null);
      // Initialize new name from source item
      setNewName(sourceItem.name);
    }
  }, [open, sourceItem, currentSourcePath]);

  // Cleanup: abort pending create folder operations when dialog closes or unmounts
  useEffect(() => {
    return () => {
      createFolderControllerRef.current?.abort();
    };
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
    onConfirm({ destinationPath: normalizedPath, newName: newName.trim() });
  }, [isManualInput, manualPath, browsePath, newName, onConfirm]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !activeConnectionId || !bucket) return;

    // Abort any pending create folder operation
    createFolderControllerRef.current?.abort();
    const controller = new AbortController();
    createFolderControllerRef.current = controller;

    setIsCreatingFolder(true);
    try {
      const fullPath = browsePath + newFolderName.trim();
      await createFolder(activeConnectionId, bucket, fullPath);

      // Check if aborted before refreshing
      if (controller.signal.aborted) return;

      // Refresh folder list
      const result = await listObjects(activeConnectionId, bucket, browsePath, undefined, controller.signal);

      // Check if aborted before updating state
      if (controller.signal.aborted) return;

      setFolders(result.objects.filter((obj) => obj.isFolder));
      setNewFolderName('');
      setShowNewFolderInput(false);
    } catch (err) {
      // Don't update error state if aborted
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      // Only update isCreatingFolder if not aborted
      if (!controller.signal.aborted) {
        setIsCreatingFolder(false);
      }
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

    // Check for empty name
    if (!newName.trim()) {
      return 'Name cannot be empty';
    }

    // Check for invalid characters in name
    if (newName.includes('/')) {
      return 'Name cannot contain "/"';
    }

    const destPath = isManualInput ? manualPath : browsePath;
    const normalizedDest = destPath.endsWith('/') ? destPath : (destPath ? destPath + '/' : '');

    // For move operations, can't move a folder into itself or its subfolders
    if (mode === 'move' && sourceItem.isFolder) {
      const sourcePrefix = sourceItem.key;
      if (normalizedDest.startsWith(sourcePrefix)) {
        return 'Cannot move a folder into itself';
      }
    }

    // Check if destination + name is the same as source
    const isFolder = sourceItem.isFolder;
    const destKey = isFolder
      ? normalizedDest + newName.trim() + '/'
      : normalizedDest + newName.trim();

    if (destKey === sourceItem.key) {
      return 'Destination is the same as source';
    }

    return null;
  }, [sourceItem, isManualInput, manualPath, browsePath, mode, newName]);

  const validationError = isInvalidDestination();
  const pathSegments = browsePath.split('/').filter(Boolean);

  // Compute the full destination for display
  const displayDestPath = isManualInput ? manualPath : browsePath;
  const normalizedDisplayPath = displayDestPath.endsWith('/') ? displayDestPath : (displayDestPath ? displayDestPath + '/' : '');
  const fullDestination = normalizedDisplayPath + newName.trim() + (sourceItem?.isFolder ? '/' : '');

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="sm:max-w-md min-h-[400px] max-h-[80vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Name input */}
          <div className="px-6 py-3 border-b">
            <Label htmlFor="newName" className="text-sm">
              {sourceItem?.isFolder ? 'Folder name' : 'File name'}
            </Label>
            <Input
              id="newName"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className={`mt-1 ${!newName.trim() || newName.includes('/') ? 'border-destructive' : ''}`}
            />
            {(!newName.trim() || newName.includes('/')) && (
              <p className="text-xs text-destructive mt-1">
                {!newName.trim() ? 'Name is required' : 'Name cannot contain "/"'}
              </p>
            )}
          </div>

          {/* Breadcrumb navigation */}
          <div className="px-6 py-2 border-b">
            <div className="flex items-center gap-2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={handleGoUp}
                      disabled={browsePath === '' || isManualInput}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Go up</TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <Breadcrumb className="flex-1 min-w-0">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (!isManualInput) handleBreadcrumbClick(0);
                      }}
                      className={`flex items-center ${isManualInput ? 'pointer-events-none opacity-50' : ''}`}
                    >
                      <Home className="h-4 w-4 mr-1" />
                      Root
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  {pathSegments.map((segment, index) => (
                    <BreadcrumbItem key={index}>
                      <BreadcrumbSeparator />
                      <BreadcrumbLink
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          if (!isManualInput) handleBreadcrumbClick(index + 1);
                        }}
                        className={`max-w-[120px] truncate ${isManualInput ? 'pointer-events-none opacity-50' : ''}`}
                      >
                        {segment}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                  ))}
                </BreadcrumbList>
              </Breadcrumb>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={toggleManualInput}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isManualInput ? 'Browse folders' : 'Enter path manually'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          {/* Manual path input */}
          {isManualInput && (
            <div className="px-6 py-3 border-b">
              <Label htmlFor="manualPath" className="text-sm">Destination folder</Label>
              <Input
                id="manualPath"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder="Enter folder path (e.g., folder/subfolder/)"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">Leave empty for root</p>
            </div>
          )}

          {/* Error alert */}
          {error && (
            <Alert variant="destructive" className="mx-6 mt-3">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Validation error */}
          {validationError && validationError !== 'Name cannot be empty' && !validationError.includes('cannot contain') && (
            <Alert className="mx-6 mt-3 border-yellow-500 bg-yellow-50 text-yellow-800">
              <AlertDescription>{validationError}</AlertDescription>
            </Alert>
          )}

          {/* Folder list */}
          {!isManualInput && (
            <ScrollArea className="flex-1 min-h-[200px]">
              {isLoading ? (
                <div className="flex justify-center py-8">
                  <Spinner size="md" />
                </div>
              ) : folders.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No subfolders in this location
                </p>
              ) : (
                <div className="py-1">
                  {folders.map((folder) => (
                    <button
                      key={folder.key}
                      onClick={() => handleFolderClick(folder.key)}
                      className="w-full flex items-center gap-3 px-6 py-2 hover:bg-muted transition-colors text-left"
                    >
                      <Folder className="h-5 w-5 text-yellow-500 shrink-0" />
                      <span className="truncate max-w-[300px]">{folder.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          )}

          {/* Create new folder */}
          {!isManualInput && (
            <div className="px-6 py-3 border-t">
              {showNewFolderInput ? (
                <div className="flex gap-2">
                  <Input
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
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleCreateFolder}
                    disabled={!newFolderName.trim() || isCreatingFolder}
                  >
                    {isCreatingFolder ? (
                      <Spinner size="sm" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setShowNewFolderInput(false);
                      setNewFolderName('');
                    }}
                    disabled={isCreatingFolder}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowNewFolderInput(true)}
                >
                  <FolderPlus className="h-4 w-4 mr-2" />
                  Create New Folder
                </Button>
              )}
            </div>
          )}

          {/* Current selection display */}
          <div className="px-6 py-2 bg-muted/50">
            <p className="text-xs text-muted-foreground">
              {mode === 'copy' ? 'Copy' : 'Move'} to:{' '}
              <strong>{fullDestination || '/ (root)'}</strong>
            </p>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!!validationError}>
            {mode === 'copy' ? 'Copy Here' : 'Move Here'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
