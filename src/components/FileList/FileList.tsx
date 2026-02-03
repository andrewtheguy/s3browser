import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowDown, ArrowUp, ArrowUpDown, FolderX } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useBrowserContext } from '../../contexts';
import { useDownload } from '../../hooks';
import { BROWSE_WINDOW_LIMIT } from '../../config/browse';
import { FileListItem } from './FileListItem';
import type { S3Object } from '../../types';
import { getObjectSelectionId } from '../../utils/formatters';

interface FileListProps {
  onDeleteRequest: (item: S3Object) => void;
  onCopyRequest: (item: S3Object) => void;
  onMoveRequest: (item: S3Object) => void;
  onCopyUrl: (key: string, ttl: number) => void;
  onCopyS3Uri: (key: string) => void;
  onPreview: (item: S3Object) => void;
  selectedIds: Set<string>;
  onSelectItem: (id: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  selectionMode?: boolean;
}

type SortKey = 'name' | 'size' | 'lastModified';
type SortDirection = 'asc' | 'desc';

const DEFAULT_SORT_DIRECTION: Record<SortKey, SortDirection> = {
  name: 'asc',
  size: 'desc',
  lastModified: 'desc',
};
const PAGE_QUERY_PARAM = 'page';

export function FileList({
  onDeleteRequest,
  onCopyRequest,
  onMoveRequest,
  onCopyUrl,
  onCopyS3Uri,
  onPreview,
  selectedIds,
  onSelectItem,
  onSelectAll,
  selectionMode = false,
}: FileListProps) {
  const {
    objects,
    isLoading,
    error,
    navigateTo,
    isLimited,
    limitMessage,
    windowStart,
    hasNextWindow,
    loadNextWindow,
    hasPrevWindow,
    loadPrevWindow,
    showVersions,
  } = useBrowserContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentPage, setCurrentPage] = useState(() => {
    const pageParam = searchParams.get(PAGE_QUERY_PARAM);
    const parsedPage = pageParam ? Number(pageParam) : NaN;
    return Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;
  });
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'name',
    direction: DEFAULT_SORT_DIRECTION.name,
  });
  const pageSize = 500;
  const nameCollator = useMemo(
    () => new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }),
    []
  );
  const sortedObjects = useMemo(() => {
    if (objects.length === 0) {
      return objects;
    }

    const folders: S3Object[] = [];
    const files: S3Object[] = [];

    for (const item of objects) {
      if (item.isFolder) {
        folders.push(item);
      } else {
        files.push(item);
      }
    }

    const compareName = (a: S3Object, b: S3Object) => nameCollator.compare(a.name, b.name);
    const compareFiles = (a: S3Object, b: S3Object) => {
      const nameDiff = compareName(a, b);
      if (showVersions && nameDiff === 0) {
        const latestDiff = Number(b.isLatest ?? true) - Number(a.isLatest ?? true);
        if (latestDiff !== 0) {
          return latestDiff;
        }
        const versionTimeDiff = (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0);
        if (versionTimeDiff !== 0) {
          return versionTimeDiff;
        }
      }

      if (sortConfig.key === 'size') {
        const sizeDiff = (a.size ?? 0) - (b.size ?? 0);
        if (sizeDiff !== 0) {
          return sizeDiff;
        }
      } else if (sortConfig.key === 'lastModified') {
        const timeDiff = (a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0);
        if (timeDiff !== 0) {
          return timeDiff;
        }
      }
      return nameDiff;
    };

    const sortedFolders = [...folders].sort(compareName);
    const sortedFiles = [...files].sort(compareFiles);

    const filesOrdered =
      sortConfig.direction === 'desc' ? [...sortedFiles].reverse() : sortedFiles;

    let foldersOrdered = sortedFolders;
    if (sortConfig.key === 'name' && sortConfig.direction === 'desc') {
      foldersOrdered = [...sortedFolders].reverse();
    }

    return [...foldersOrdered, ...filesOrdered];
  }, [objects, sortConfig, nameCollator, showVersions]);

  const totalItems = sortedObjects.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const clampedPage = Math.min(currentPage, totalPages);
  const pageStartIndex = (clampedPage - 1) * pageSize;
  const pageEndIndex = Math.min(pageStartIndex + pageSize, totalItems);
  const pageItems = useMemo(
    () => sortedObjects.slice(pageStartIndex, pageEndIndex),
    [sortedObjects, pageStartIndex, pageEndIndex]
  );

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const pageParam = searchParams.get(PAGE_QUERY_PARAM);
    const parsedPage = pageParam ? Number(pageParam) : NaN;
    const hasValidPageParam = Number.isFinite(parsedPage) && parsedPage >= 1;

    let nextPage = 1;
    if (totalPages > 1 && hasValidPageParam) {
      nextPage = Math.min(totalPages, Math.floor(parsedPage));
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync pagination with query params
    setCurrentPage((prev) => (prev === nextPage ? prev : nextPage));
  }, [isLoading, searchParams, totalPages]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (totalPages <= 1) {
      if (searchParams.has(PAGE_QUERY_PARAM)) {
        const nextParams = new URLSearchParams(searchParams);
        nextParams.delete(PAGE_QUERY_PARAM);
        setSearchParams(nextParams, { replace: true });
      }
      return;
    }

    const pageValue = String(clampedPage);
    if (searchParams.get(PAGE_QUERY_PARAM) !== pageValue) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set(PAGE_QUERY_PARAM, pageValue);
      setSearchParams(nextParams, { replace: true });
    }
  }, [clampedPage, isLoading, searchParams, setSearchParams, totalPages]);
  const paginationItems = useMemo(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    const items: Array<number | 'ellipsis'> = [];
    const windowSize = 2;
    const leftBoundary = Math.max(2, clampedPage - windowSize);
    const rightBoundary = Math.min(totalPages - 1, clampedPage + windowSize);

    items.push(1);

    if (leftBoundary > 2) {
      items.push('ellipsis');
    }

    for (let page = leftBoundary; page <= rightBoundary; page += 1) {
      items.push(page);
    }

    if (rightBoundary < totalPages - 1) {
      items.push('ellipsis');
    }

    items.push(totalPages);
    return items;
  }, [totalPages, clampedPage]);

  const selectableItems = showVersions
    ? sortedObjects.filter((item) => item.isLatest !== false)
    : sortedObjects;
  const selectableCount = selectableItems.length;
  const selectedCount = selectableItems.filter((item) => selectedIds.has(getObjectSelectionId(item))).length;
  const isAllSelected = selectableCount > 0 && selectedCount === selectableCount;
  const isIndeterminate = selectedCount > 0 && selectedCount < selectableCount;
  const { download } = useDownload();

  const handleDownload = useCallback(
    (key: string) => {
      void download(key);
    },
    [download]
  );

  const handleSort = useCallback((key: SortKey) => {
    setCurrentPage(1);
    setSortConfig((prev) => {
      if (prev.key === key) {
        return {
          key,
          direction: prev.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      return {
        key,
        direction: DEFAULT_SORT_DIRECTION[key],
      };
    });
  }, []);

  const renderSortIcon = useCallback(
    (key: SortKey) => {
      if (sortConfig.key !== key) {
        return <ArrowUpDown className="h-3.5 w-3.5" />;
      }
      return sortConfig.direction === 'asc' ? (
        <ArrowUp className="h-3.5 w-3.5" />
      ) : (
        <ArrowDown className="h-3.5 w-3.5" />
      );
    },
    [sortConfig]
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
              {selectionMode && <TableHead className="w-14 px-2" />}
              <TableHead className="w-12" />
              <TableHead className="min-w-[120px]">Name</TableHead>
              <TableHead className="w-[72px] sm:w-[100px]">Size</TableHead>
              <TableHead className="w-[120px] sm:w-[180px]">Last Modified</TableHead>
              {showVersions && <TableHead className="min-w-[160px]">Version Id</TableHead>}
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
                {showVersions && (
                  <TableCell>
                    <Skeleton className="w-4/5 h-4" />
                  </TableCell>
                )}
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
      {(isLimited || hasPrevWindow) && (
        <Alert className="mb-3 border-yellow-300 bg-yellow-50 text-yellow-900 dark:border-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-200">
          <AlertTitle>Results limited</AlertTitle>
          <AlertDescription>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>
                {limitMessage || (
                  totalItems > 0
                    ? `Showing items ${windowStart + 1}-${windowStart + totalItems}.`
                    : 'Results are limited for this folder.'
                )}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {hasPrevWindow && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadPrevWindow()}
                    disabled={isLoading}
                  >
                    Load previous {BROWSE_WINDOW_LIMIT.toLocaleString()}
                  </Button>
                )}
                {hasNextWindow && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadNextWindow()}
                    disabled={isLoading}
                  >
                    Load next {BROWSE_WINDOW_LIMIT.toLocaleString()}
                  </Button>
                )}
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <div className={cn("overflow-x-auto", isLimited && "bg-yellow-100/70 dark:bg-yellow-900/20")}>
        <Table>
          <TableHeader>
            <TableRow>
              {selectionMode && (
                <TableHead className="w-14 px-2">
                  {selectableCount > 0 && (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isAllSelected ? 'true' : isIndeterminate ? 'mixed' : 'false'}
                      aria-label="Select all files"
                      className="flex h-8 w-full items-center justify-center rounded-md hover:bg-muted/70 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectAll(!isAllSelected);
                      }}
                    >
                      <Checkbox
                        checked={isAllSelected ? true : isIndeterminate ? 'indeterminate' : false}
                        className="h-5 w-5 pointer-events-none"
                        aria-hidden="true"
                        tabIndex={-1}
                      />
                    </button>
                  )}
                </TableHead>
              )}
              <TableHead className="w-12" />
              <TableHead className="min-w-[120px]">
                <button
                  type="button"
                  onClick={() => handleSort('name')}
                  className={cn(
                    "inline-flex items-center gap-1 hover:text-foreground",
                    sortConfig.key === 'name' ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  <span>Name</span>
                  {renderSortIcon('name')}
                </button>
              </TableHead>
              <TableHead className="w-[72px] sm:w-[100px]">
                <button
                  type="button"
                  onClick={() => handleSort('size')}
                  className={cn(
                    "inline-flex items-center gap-1 hover:text-foreground",
                    sortConfig.key === 'size' ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  <span>Size</span>
                  {renderSortIcon('size')}
                </button>
              </TableHead>
              <TableHead className="w-[120px] sm:w-[180px]">
                <button
                  type="button"
                  onClick={() => handleSort('lastModified')}
                  className={cn(
                    "inline-flex items-center gap-1 hover:text-foreground",
                    sortConfig.key === 'lastModified' ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  <span>Last Modified</span>
                  {renderSortIcon('lastModified')}
                </button>
              </TableHead>
              {showVersions && <TableHead className="min-w-[160px]">Version Id</TableHead>}
              <TableHead className="w-[160px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.map((item) => (
              <FileListItem
                key={getObjectSelectionId(item)}
                item={item}
                showVersions={showVersions}
                selectionId={getObjectSelectionId(item)}
                onNavigate={navigateTo}
                onDownload={handleDownload}
                onCopyUrl={onCopyUrl}
                onCopyS3Uri={onCopyS3Uri}
                onDelete={onDeleteRequest}
                onCopy={onCopyRequest}
                onMove={onMoveRequest}
                onPreview={onPreview}
                isSelected={selectedIds.has(getObjectSelectionId(item))}
                onSelect={onSelectItem}
                selectionMode={selectionMode}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      {totalItems > pageSize && (
        <div className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="text-sm text-muted-foreground">
            Showing {pageStartIndex + 1}-{pageEndIndex} of {totalItems}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(1)}
              disabled={clampedPage === 1}
            >
              First
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(Math.max(1, clampedPage - 1))}
              disabled={clampedPage === 1}
            >
              Previous
            </Button>
            {paginationItems.map((item, index) => {
              if (item === 'ellipsis') {
                return (
                  <span key={`ellipsis-${index}`} className="px-2 text-sm text-muted-foreground">
                    …
                  </span>
                );
              }

              return (
                <Button
                  key={item}
                  variant={item === clampedPage ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setCurrentPage(item)}
                >
                  {item}
                </Button>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(Math.min(totalPages, clampedPage + 1))}
              disabled={clampedPage === totalPages}
            >
              Next
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(totalPages)}
              disabled={clampedPage === totalPages}
            >
              Last
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
