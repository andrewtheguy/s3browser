import { useState } from 'react';
import {
  File,
  Image,
  Video,
  Music,
  FileText,
  FileSpreadsheet,
  FileArchive,
  FileCode,
  Download,
  Link,
  Trash2,
  Copy,
  FolderInput,
  Info,
  MoreVertical,
} from 'lucide-react';
import { FolderIcon } from '@/components/icons';
import { TableRow, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { usePresignedUrlTtlOptions } from '../../config';
import type { S3Object } from '../../types';
import { formatFileSize, formatDate } from '../../utils/formatters';
import { getFileIconType, type FileIconType } from '../../utils/fileIcons';
import { FileDetailsDialog } from './FileDetailsDialog';

interface FileListItemProps {
  item: S3Object;
  onNavigate: (path: string) => void;
  onDownload: (key: string, versionId?: string) => void;
  onCopyUrl: (key: string, ttl: number, versionId?: string) => void;
  onCopyS3Uri: (key: string) => void;
  onDelete: (item: S3Object) => void;
  onCopy: (item: S3Object) => void;
  onMove: (item: S3Object) => void;
  onPreview: (item: S3Object) => void;
  onBatchDownload?: (item: S3Object) => void;
  selectionId: string;
  showVersions: boolean;
  isSelected?: boolean;
  onSelect?: (id: string, checked: boolean) => void;
  selectionMode?: boolean;
}

const iconMap: Record<FileIconType, React.ElementType> = {
  folder: FolderIcon,
  image: Image,
  video: Video,
  audio: Music,
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  archive: FileArchive,
  code: FileCode,
  text: FileText,
  file: File,
};

/** Tile background + glyph colour per file type. */
const iconTones: Record<FileIconType, string> = {
  folder: 'bg-primary/12 text-primary-ink',
  image: 'bg-file-image/12 text-file-image',
  video: 'bg-file-video/12 text-file-video',
  audio: 'bg-file-audio/12 text-file-audio',
  pdf: 'bg-file-pdf/12 text-file-pdf',
  document: 'bg-file-document/12 text-file-document',
  spreadsheet: 'bg-file-spreadsheet/12 text-file-spreadsheet',
  archive: 'bg-file-archive/12 text-file-archive',
  code: 'bg-file-code/12 text-file-code',
  text: 'bg-muted text-muted-foreground',
  file: 'bg-muted text-muted-foreground',
};

/** Orange rule on the row's first cell (box-shadow on <tr> is unreliable). */
const leadingRuleClass =
  'shadow-[inset_3px_0_0_transparent] transition-shadow group-hover:shadow-[inset_3px_0_0_var(--color-primary)] group-data-[state=selected]:shadow-[inset_3px_0_0_var(--color-primary)]';

const tagClass = 'ml-2 inline-block rounded-sm px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide';

export function FileListItem({
  item,
  onNavigate,
  onDownload,
  onCopyUrl,
  onCopyS3Uri,
  onDelete,
  onCopy,
  onMove,
  onPreview,
  onBatchDownload,
  selectionId,
  showVersions,
  isSelected = false,
  onSelect,
  selectionMode = false,
}: FileListItemProps) {
  const iconType = getFileIconType(item.name, item.isFolder);
  const IconComponent = iconMap[iconType];
  const iconTone = iconTones[iconType];
  const isPreviousVersion = showVersions && item.isLatest === false;
  const isDeleteMarker = showVersions && item.isDeleteMarker === true;
  // Folders can always be navigated (even if deleted), but deleted files can't be previewed
  const canPreview = !isDeleteMarker || item.isFolder;
  const canCopyMove = !isDeleteMarker && !isPreviousVersion;
  const canBatchDownload = Boolean(onBatchDownload) && item.isFolder && !isDeleteMarker && !isPreviousVersion;
  const isInteractive = canPreview;
  const isSelectable = true;

  const [detailsOpen, setDetailsOpen] = useState(false);
  const ttlOptions = usePresignedUrlTtlOptions();

  const handleClick = () => {
    if (!isInteractive) {
      return;
    }
    if (item.isFolder) {
      onNavigate(item.key);
    } else {
      onPreview(item);
    }
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDownload(item.key, item.versionId);
  };

  const handleCheckboxToggle = (checked: boolean) => {
    onSelect?.(selectionId, checked);
  };

  return (
    <TooltipProvider>
      <TableRow
        onClick={handleClick}
        data-state={isSelected ? 'selected' : undefined}
        className={cn(
          "group",
          isInteractive ? "cursor-pointer hover:bg-accent/60" : "cursor-default",
          isSelected && "bg-primary/8 hover:bg-primary/12",
          (isPreviousVersion || isDeleteMarker) && "text-muted-foreground"
        )}
      >
        {selectionMode && (
          <TableCell
            className={cn("w-14 px-2", leadingRuleClass)}
            onClick={(e) => {
              e.stopPropagation();
              if (isSelectable && onSelect) {
                handleCheckboxToggle(!isSelected);
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {isSelectable && onSelect && (
              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`Select ${item.name}${item.isFolder ? '/' : ''}`}
                className="flex h-9 w-full items-center justify-center rounded-md transition-colors hover:bg-accent"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCheckboxToggle(!isSelected);
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <Checkbox
                  checked={isSelected}
                  className="h-5 w-5 pointer-events-none"
                  aria-hidden="true"
                  tabIndex={-1}
                />
              </button>
            )}
          </TableCell>
        )}
        <TableCell className={cn("w-14 pr-0", !selectionMode && leadingRuleClass)}>
          <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg", iconTone)}>
            <IconComponent className="h-5 w-5" />
          </span>
        </TableCell>
        <TableCell className="min-w-[120px]">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "block truncate max-w-[clamp(140px,35vw,70vw)]",
                  item.isFolder && isInteractive ? "font-medium hover:underline" : ""
                )}
              >
                {item.name}
                {item.isFolder && '/'}
                {isPreviousVersion && (
                  <span className={cn(tagClass, "bg-muted text-muted-foreground")}>previous version</span>
                )}
                {isDeleteMarker && (
                  <span className={cn(tagClass, "bg-destructive/10 text-destructive")}>deleted</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              {item.name}{item.isFolder ? '/' : ''}
            </TooltipContent>
          </Tooltip>
        </TableCell>
        <TableCell className="w-[72px] sm:w-[100px]">
          <span className="block truncate font-mono text-xs tabular-nums text-muted-foreground">
            {formatFileSize(item.size)}
          </span>
        </TableCell>
        <TableCell className="w-[120px] sm:w-[180px]">
          <span className="block truncate text-sm tabular-nums text-muted-foreground">
            {formatDate(item.lastModified)}
          </span>
        </TableCell>
        {showVersions && (
          <TableCell className="min-w-[160px]">
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {item.versionId ?? '-'}
            </span>
          </TableCell>
        )}
        <TableCell className="w-[120px] text-right">
          <div className="flex justify-end">
            {!item.isFolder && (
              <>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild disabled={!canPreview}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => e.stopPropagation()}
                          disabled={!canPreview}
                        >
                          <Link className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Copy URL</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    {ttlOptions.map((option) => (
                      <DropdownMenuItem
                        key={option.shortLabel}
                        onClick={() => onCopyUrl(item.key, option.ttl, showVersions ? item.versionId : undefined)}
                      >
                        Presigned URL ({option.longLabel})
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onClick={() => onCopyS3Uri(item.key)}>
                      S3 URI (s3://...)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={handleDownload}
                      disabled={!canPreview}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Download</TooltipContent>
                </Tooltip>
              </>
            )}

            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>More actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={() => setDetailsOpen(true)}>
                  <Info className="h-4 w-4 mr-2" />
                  Details
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCopy(item)} disabled={!canCopyMove}>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy to...
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMove(item)} disabled={!canCopyMove}>
                  <FolderInput className="h-4 w-4 mr-2" />
                  Move to...
                </DropdownMenuItem>
                {canBatchDownload && (
                  <DropdownMenuItem onClick={() => onBatchDownload?.(item)}>
                    <Download className="h-4 w-4 mr-2" />
                    Download folder contents
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => onDelete(item)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  {item.isFolder ? 'Delete folder and contents' : 'Delete'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableCell>
      </TableRow>
      <FileDetailsDialog open={detailsOpen} item={item} onClose={() => setDetailsOpen(false)} />
    </TooltipProvider>
  );
}
