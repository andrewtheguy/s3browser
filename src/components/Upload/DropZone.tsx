import { useCallback, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { UploadCandidate } from '../../types';

interface FileSystemDirectoryReaderLike {
  readEntries: (
    success: (entries: FileSystemEntryLike[]) => void,
    error?: (err: DOMException) => void
  ) => void;
}

interface FileSystemDirectoryHandleWithEntries extends FileSystemDirectoryHandle {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (err: DOMException) => void) => void;
  createReader?: () => FileSystemDirectoryReaderLike;
}

type DataTransferItemWithHandle = DataTransferItem & {
  getAsFileSystemHandle: () => Promise<FileSystemHandle | null>;
};

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry: () => FileSystemEntryLike | null;
};

const hasFileSystemHandle = (item: DataTransferItem): item is DataTransferItemWithHandle =>
  'getAsFileSystemHandle' in item;

const hasWebkitEntry = (item: DataTransferItem): item is DataTransferItemWithEntry =>
  'webkitGetAsEntry' in item;

const isFileHandle = (handle: FileSystemHandle): handle is FileSystemFileHandle =>
  handle.kind === 'file';

const isDirectoryHandle = (handle: FileSystemHandle): handle is FileSystemDirectoryHandle =>
  handle.kind === 'directory';

interface DropZoneProps {
  onFilesSelected: (files: UploadCandidate[]) => void | Promise<void>;
  disabled?: boolean;
}

export function DropZone({ onFilesSelected, disabled = false }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const dragDepthRef = useRef(0);
  const supportsFileSystemAccess = useMemo(() => {
    if (typeof window === 'undefined') {
      return { files: false, directory: false };
    }
    const win = window as Window & {
      showOpenFilePicker?: () => Promise<FileSystemFileHandle[]>;
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    };
    return {
      files: typeof win.showOpenFilePicker === 'function',
      directory: typeof win.showDirectoryPicker === 'function',
    };
  }, []);

  const normalizeRelativePath = useCallback((path: string) => {
    return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  }, []);

  const mapFileToCandidate = useCallback(
    (file: File, relativePath?: string): UploadCandidate => {
      const webkitRelativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const resolvedPath = relativePath || webkitRelativePath || file.name;
      return {
        file,
        relativePath: normalizeRelativePath(resolvedPath),
      };
    },
    [normalizeRelativePath]
  );

  const collectFilesFromHandle = useCallback(
    async (handle: FileSystemHandle, prefix = ''): Promise<UploadCandidate[]> => {
      if (isFileHandle(handle)) {
        const file = await handle.getFile();
        return [mapFileToCandidate(file, `${prefix}${handle.name}`)];
      }
      if (isDirectoryHandle(handle)) {
        const entries: UploadCandidate[] = [];
        const nextPrefix = `${prefix}${handle.name}/`;
        const directoryHandle = handle as FileSystemDirectoryHandleWithEntries;
        for await (const [, entry] of directoryHandle.entries()) {
          entries.push(...await collectFilesFromHandle(entry, nextPrefix));
        }
        return entries;
      }
      return [];
    },
    [mapFileToCandidate]
  );

  const readAllEntries = useCallback(async (reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> => {
    const entries: FileSystemEntryLike[] = [];
    const readBatch = (): Promise<void> =>
      new Promise((resolve, reject) => {
        reader.readEntries(
          (batch: FileSystemEntryLike[]) => {
            if (batch.length === 0) {
              resolve();
              return;
            }
            entries.push(...batch);
            void readBatch().then(resolve).catch(reject);
          },
          (err: DOMException) => reject(err)
        );
      });

    await readBatch();
    return entries;
  }, []);

  const collectFilesFromEntry = useCallback(
    async (entry: FileSystemEntryLike, prefix = ''): Promise<UploadCandidate[]> => {
      if (!entry) return [];
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => {
          if (!entry.file) {
            reject(new DOMException('Missing file handler'));
            return;
          }
          entry.file((value: File) => resolve(value), (err: DOMException) => reject(err));
        });
        return [mapFileToCandidate(file, `${prefix}${entry.name}`)];
      }
      if (entry.isDirectory) {
        if (!entry.createReader) {
          return [];
        }
        const reader = entry.createReader();
        const entries = await readAllEntries(reader);
        const nextPrefix = `${prefix}${entry.name}/`;
        const nested = await Promise.all(entries.map((child) => collectFilesFromEntry(child, nextPrefix)));
        return nested.flat();
      }
      return [];
    },
    [mapFileToCandidate, readAllEntries]
  );

  const collectFilesFromDataTransfer = useCallback(
    async (items: DataTransferItemList, fallbackFiles: FileList): Promise<UploadCandidate[]> => {
      const fileItems = Array.from(items).filter((item) => item.kind === 'file');
      if (fileItems.length === 0) {
        return Array.from(fallbackFiles).map((file) => mapFileToCandidate(file));
      }

      if (fileItems.every((item) => hasFileSystemHandle(item))) {
        const files = await Promise.all(
          fileItems.map(async (item) => {
            const handle = await item.getAsFileSystemHandle();
            return handle ? collectFilesFromHandle(handle) : [];
          })
        );
        return files.flat();
      }

      if (fileItems.every((item) => hasWebkitEntry(item))) {
        const entryItems = fileItems.filter(hasWebkitEntry);
        const files = await Promise.all(
          entryItems.map(async (item) => {
            const entry = item.webkitGetAsEntry();
            return entry ? collectFilesFromEntry(entry) : [];
          })
        );
        return files.flat();
      }

      return Array.from(fallbackFiles).map((file) => mapFileToCandidate(file));
    },
    [collectFilesFromEntry, collectFilesFromHandle, mapFileToCandidate]
  );

  const handleSelectedFiles = useCallback(
    async (files: UploadCandidate[]) => {
      if (files.length === 0) return;
      setIsProcessing(true);
      try {
        await Promise.resolve(onFilesSelected(files));
      } finally {
        setIsProcessing(false);
      }
    },
    [onFilesSelected]
  );

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragging) {
      setIsDragging(true);
    }
  }, [isDragging]);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragging(false);

      if (disabled || isProcessing) return;

      void (async () => {
        setIsProcessing(true);
        const fallback = Array.from(e.dataTransfer.files).map((file) => mapFileToCandidate(file));
        try {
          const files = await collectFilesFromDataTransfer(e.dataTransfer.items, e.dataTransfer.files);
          await Promise.resolve(onFilesSelected(files));
        } catch (error) {
          console.error('Failed to process dropped files:', error);
          await Promise.resolve(onFilesSelected(fallback));
        } finally {
          setIsProcessing(false);
        }
      })();
    },
    [
      collectFilesFromDataTransfer,
      disabled,
      isProcessing,
      mapFileToCandidate,
      onFilesSelected,
    ]
  );

  const handleClick = useCallback(() => {
    if (disabled || isProcessing) return;

    void (async () => {
      try {
        if (supportsFileSystemAccess.files) {
          const win = window as Window & {
            showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
          };
          const handles = await win.showOpenFilePicker?.({ multiple: true });
          const files = await Promise.all((handles || []).map((handle) => handle.getFile()));
          await handleSelectedFiles(files.map((file) => mapFileToCandidate(file)));
          return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = async (e) => {
          const files = Array.from((e.target as HTMLInputElement).files || []);
          try {
            await handleSelectedFiles(files.map((file) => mapFileToCandidate(file)));
          } catch (error) {
            console.error('Failed to process selected files:', error);
          }
        };
        input.click();
      } catch (error) {
        if (
          error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'NotAllowedError')
        ) {
          return;
        }
        console.error('Failed to select files:', error);
      }
    })();
  }, [disabled, handleSelectedFiles, isProcessing, mapFileToCandidate, supportsFileSystemAccess.files]);

  const handleSelectFolder = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (disabled || isProcessing) return;

      void (async () => {
        try {
          if (supportsFileSystemAccess.directory) {
            const win = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
            const directoryHandle = await win.showDirectoryPicker?.();
            if (directoryHandle) {
              const files = await collectFilesFromHandle(directoryHandle);
              await handleSelectedFiles(files);
            }
            return;
          }

          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.setAttribute('webkitdirectory', '');
          input.onchange = async (e) => {
            const files = Array.from((e.target as HTMLInputElement).files || []).map((file) =>
              mapFileToCandidate(file)
            );
            try {
              await handleSelectedFiles(files);
            } catch (error) {
              console.error('Failed to process selected folder files:', error);
            }
          };
          input.click();
        } catch (error) {
          if (
            error instanceof DOMException &&
            (error.name === 'AbortError' || error.name === 'NotAllowedError')
          ) {
            return;
          }
          console.error('Failed to select folder:', error);
        }
      })();
    },
    [
      collectFilesFromHandle,
      disabled,
      handleSelectedFiles,
      isProcessing,
      mapFileToCandidate,
      supportsFileSystemAccess.directory,
    ]
  );

  const handleSelectFiles = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      handleClick();
    },
    [handleClick]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleClick();
      }
    },
    [handleClick]
  );

  return (
    <div
      role="button"
      tabIndex={disabled || isProcessing ? -1 : 0}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label="Drop zone for file upload"
      className={cn(
        "border-2 border-dashed rounded-lg p-8 text-center transition-all duration-200",
        isDragging ? "border-primary bg-accent" : "border-border bg-background",
        disabled || isProcessing ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-primary hover:bg-accent"
      )}
    >
      {isProcessing ? (
        <div className="flex flex-col items-center gap-3">
          <Spinner size="md" />
          <h3 className="text-lg font-semibold">Preparing files...</h3>
          <p className="text-sm text-muted-foreground">
            Hang tight while we scan your selection.
          </p>
        </div>
      ) : (
        <>
          <Upload
            className={cn(
              "mx-auto h-12 w-12 mb-2",
              isDragging ? "text-primary" : "text-muted-foreground"
            )}
          />
          <h3 className="text-lg font-semibold mb-1">
            {isDragging ? 'Drop to upload' : 'Drag and drop files or folders here'}
          </h3>
          <p className="text-sm text-muted-foreground">
            {isDragging ? 'Release to start uploading' : 'or click to browse files or folders'}
          </p>
        </>
      )}
      <div className="flex justify-center gap-2 mt-4 flex-wrap">
        <Button variant="outline" size="sm" disabled={disabled || isProcessing} onClick={handleSelectFiles}>
          Choose Files
        </Button>
        <Button variant="outline" size="sm" disabled={disabled || isProcessing} onClick={handleSelectFolder}>
          Choose Folder
        </Button>
      </div>
    </div>
  );
}
