import { useCallback, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  onFilesSelected: (files: UploadCandidate[]) => void;
  disabled?: boolean;
}

export function DropZone({ onFilesSelected, disabled = false }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
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

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (disabled) return;

      void (async () => {
        const fallback = Array.from(e.dataTransfer.files).map((file) => mapFileToCandidate(file));
        try {
          const files = await collectFilesFromDataTransfer(e.dataTransfer.items, e.dataTransfer.files);
          if (files.length > 0) {
            onFilesSelected(files);
          }
        } catch (error) {
          console.error('Failed to process dropped files:', error);
          if (fallback.length > 0) {
            onFilesSelected(fallback);
          }
        }
      })();
    },
    [collectFilesFromDataTransfer, disabled, mapFileToCandidate, onFilesSelected]
  );

  const handleClick = useCallback(() => {
    if (disabled) return;

    void (async () => {
      try {
        if (supportsFileSystemAccess.files) {
          const win = window as Window & {
            showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
          };
          const handles = await win.showOpenFilePicker?.({ multiple: true });
          const files = await Promise.all((handles || []).map((handle) => handle.getFile()));
          if (files.length > 0) {
            onFilesSelected(files.map((file) => mapFileToCandidate(file)));
          }
          return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = (e) => {
          const files = Array.from((e.target as HTMLInputElement).files || []);
          if (files.length > 0) {
            onFilesSelected(files.map((file) => mapFileToCandidate(file)));
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
  }, [disabled, mapFileToCandidate, onFilesSelected, supportsFileSystemAccess.files]);

  const handleSelectFolder = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (disabled) return;

      void (async () => {
        try {
          if (supportsFileSystemAccess.directory) {
            const win = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
            const directoryHandle = await win.showDirectoryPicker?.();
            if (directoryHandle) {
              const files = await collectFilesFromHandle(directoryHandle);
              if (files.length > 0) {
                onFilesSelected(files);
              }
            }
            return;
          }

          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.setAttribute('webkitdirectory', '');
          input.onchange = (e) => {
            const files = Array.from((e.target as HTMLInputElement).files || []).map((file) =>
              mapFileToCandidate(file)
            );
            if (files.length > 0) {
              onFilesSelected(files);
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
    [collectFilesFromHandle, disabled, mapFileToCandidate, onFilesSelected, supportsFileSystemAccess.directory]
  );

  const handleSelectFiles = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      handleClick();
    },
    [handleClick]
  );

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={handleClick}
      className={cn(
        "border-2 border-dashed rounded-lg p-8 text-center transition-all duration-200",
        isDragging ? "border-primary bg-accent" : "border-border bg-background",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-primary hover:bg-accent"
      )}
    >
      <Upload
        className={cn(
          "mx-auto h-12 w-12 mb-2",
          isDragging ? "text-primary" : "text-muted-foreground"
        )}
      />
      <h3 className="text-lg font-semibold mb-1">
        Drag and drop files or folders here
      </h3>
      <p className="text-sm text-muted-foreground">
        or click to browse files or folders
      </p>
      <div className="flex justify-center gap-2 mt-4 flex-wrap">
        <Button variant="outline" size="sm" disabled={disabled} onClick={handleSelectFiles}>
          Choose Files
        </Button>
        <Button variant="outline" size="sm" disabled={disabled} onClick={handleSelectFolder}>
          Choose Folder
        </Button>
      </div>
    </div>
  );
}
