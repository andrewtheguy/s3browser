import { useCallback } from 'react';
import { FolderX } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useBrowserContext } from '../../contexts';
import { useDownload } from '../../hooks';
import { FileListItem } from './FileListItem';
import type { S3Object } from '../../types';

interface FileListProps {
  onDeleteRequest: (item: S3Object) => void;
  onCopyRequest: (item: S3Object) => void;
  onMoveRequest: (item: S3Object) => void;
  onCopyUrl: (key: string, ttl: number) => void;
  onCopyS3Uri: (key: string) => void;
  onPreview: (item: S3Object) => void;
  selectedKeys: Set<string>;
  onSelectItem: (key: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  selectionMode?: boolean;
}

export function FileList({
  onDeleteRequest,
  onCopyRequest,
  onMoveRequest,
  onCopyUrl,
  onCopyS3Uri,
  onPreview,
  selectedKeys,
  onSelectItem,
  onSelectAll,
  selectionMode = false,
}: FileListProps) {
  const { objects, isLoading, error, navigateTo, isTruncated, isLoadingMore, loadMore } = useBrowserContext();

  const selectableItems = objects;
  const selectableCount = selectableItems.length;
  const selectedCount = selectableItems.filter((item) => selectedKeys.has(item.key)).length;
  const isAllSelected = selectableCount > 0 && selectedCount === selectableCount;
  const isIndeterminate = selectedCount > 0 && selectedCount < selectableCount;
  const { download } = useDownload();

  const handleDownload = useCallback(
    (key: string) => {
      void download(key);
    },
    [download]
  );

  if (error) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {selectionMode && <TableHead className="w-12 px-2" />}
              <TableHead className="w-12" />
              <TableHead className="min-w-[120px]">Name</TableHead>
              <TableHead className="w-[72px] sm:w-[100px]">Size</TableHead>
              <TableHead className="w-[120px] sm:w-[180px]">Last Modified</TableHead>
              <TableHead className="w-[160px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }).map((_, index) => (
              <TableRow key={index}>
                {selectionMode && (
                  <TableCell className="px-2">
                    <Skeleton className="w-5 h-5" />
                  </TableCell>
                )}
                <TableCell>
                  <Skeleton className="w-6 h-6 rounded-full" />
                </TableCell>
                <TableCell>
                  <Skeleton className="w-3/5 h-4" />
                </TableCell>
                <TableCell>
                  <Skeleton className="w-4/5 h-4" />
                </TableCell>
                <TableCell>
                  <Skeleton className="w-4/5 h-4" />
                </TableCell>
                <TableCell>
                  <Skeleton className="w-[60px] h-4" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  if (objects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <FolderX className="h-16 w-16 mb-4 opacity-50" />
        <h3 className="text-lg font-semibold">This folder is empty</h3>
        <p className="text-sm">
          Upload files or create a new folder to get started
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {selectionMode && (
                <TableHead className="w-12 px-2">
                  {selectableCount > 0 && (
                    <Checkbox
                      checked={isAllSelected ? true : isIndeterminate ? 'indeterminate' : false}
                      onCheckedChange={(checked) => onSelectAll(!!checked)}
                    />
                  )}
                </TableHead>
              )}
              <TableHead className="w-12" />
              <TableHead className="min-w-[120px]">Name</TableHead>
              <TableHead className="w-[72px] sm:w-[100px]">Size</TableHead>
              <TableHead className="w-[120px] sm:w-[180px]">Last Modified</TableHead>
              <TableHead className="w-[160px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {objects.map((item) => (
              <FileListItem
                key={item.key}
                item={item}
                onNavigate={navigateTo}
                onDownload={handleDownload}
                onCopyUrl={onCopyUrl}
                onCopyS3Uri={onCopyS3Uri}
                onDelete={onDeleteRequest}
                onCopy={onCopyRequest}
                onMove={onMoveRequest}
                onPreview={onPreview}
                isSelected={selectedKeys.has(item.key)}
                onSelect={onSelectItem}
                selectionMode={selectionMode}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      {isTruncated && (
        <div className="flex justify-center py-4">
          <Button
            variant="outline"
            onClick={loadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore && <Spinner size="sm" className="mr-2" />}
            {isLoadingMore ? 'Loading...' : 'Load More'}
          </Button>
        </div>
      )}
    </>
  );
}
