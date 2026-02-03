import { useState } from 'react';
import {
  Folder,
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
import type { S3Object } from '../../types';
import { formatFileSize, formatDate } from '../../utils/formatters';
import { getFileIconType, type FileIconType } from '../../utils/fileIcons';
import { FileDetailsDialog } from './FileDetailsDialog';

interface FileListItemProps {
  item: S3Object;
  onNavigate: (path: string) => void;
  onDownload: (key: string) => void;
  onCopyUrl: (key: string, ttl: number) => void;
  onCopyS3Uri: (key: string) => void;
  onDelete: (item: S3Object) => void;
  onCopy: (item: S3Object) => void;
  onMove: (item: S3Object) => void;
  onPreview: (item: S3Object) => void;
  selectionId: string;
  showVersions: boolean;
  isSelected?: boolean;
  onSelect?: (id: string, checked: boolean) => void;
  selectionMode?: boolean;
}

const iconMap: Record<FileIconType, React.ElementType> = {
  folder: Folder,
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

const iconColors: Record<FileIconType, string> = {
  folder: 'text-yellow-500',
  image: 'text-green-500',
  video: 'text-red-500',
  audio: 'text-purple-500',
  pdf: 'text-red-600',
  document: 'text-blue-500',
  spreadsheet: 'text-green-600',
  archive: 'text-amber-700',
  code: 'text-teal-500',
  text: 'text-slate-500',
  file: 'text-slate-400',
};

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
  selectionId,
  showVersions,
  isSelected = false,
  onSelect,
  selectionMode = false,
}: FileListItemProps) {
  const iconType = getFileIconType(item.name, item.isFolder);
  const IconComponent = iconMap[iconType];
  const iconColor = iconColors[iconType];
  const isPreviousVersion = showVersions && item.isLatest === false;
  const isDeleteMarker = showVersions && item.isDeleteMarker === true;
  const isInteractive = !isPreviousVersion && !isDeleteMarker;
  const isSelectable = !showVersions || (item.isLatest !== false && !item.isDeleteMarker);

  const [detailsOpen, setDetailsOpen] = useState(false);

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
    onDownload(item.key);
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
          isInteractive ? "cursor-pointer hover:bg-muted/50" : "cursor-default",
          isSelected && "bg-muted",
          isPreviousVersion && "text-muted-foreground"
        )}
      >
        {selectionMode && (
          <TableCell
            className="w-14 px-2"
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
                className="flex h-8 w-full items-center justify-center rounded-md hover:bg-muted/70 transition-colors group-hover:bg-muted/50"
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
        <TableCell className="w-12">
          <IconComponent className={cn("h-6 w-6", iconColor)} />
        </TableCell>
        <TableCell className="min-w-[120px]">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "block truncate max-w-[clamp(140px,35vw,320px)]",
                  item.isFolder && isInteractive ? "font-medium hover:underline" : ""
                )}
              >
                {isPreviousVersion ? '|_ ' : ''}
                {item.name}
                {item.isFolder && '/'}
                {isPreviousVersion && (
                  <span className="ml-2 text-xs text-muted-foreground">previous version</span>
                )}
                {isDeleteMarker && (
                  <span className="ml-2 text-xs text-muted-foreground">deleted</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              {item.name}{item.isFolder ? '/' : ''}
            </TooltipContent>
          </Tooltip>
        </TableCell>
        <TableCell className="w-[72px] sm:w-[100px]">
          <span className="block text-sm text-muted-foreground truncate">
            {formatFileSize(item.size)}
          </span>
        </TableCell>
        <TableCell className="w-[120px] sm:w-[180px]">
          <span className="block text-sm text-muted-foreground truncate">
            {formatDate(item.lastModified)}
          </span>
        </TableCell>
        {showVersions && (
          <TableCell className="min-w-[160px]">
            <span className="block text-sm text-muted-foreground truncate">
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
                      <DropdownMenuTrigger asChild disabled={!isInteractive}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => e.stopPropagation()}
                          disabled={!isInteractive}
                        >
                          <Link className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Copy URL</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem onClick={() => onCopyUrl(item.key, 3600)}>
                      Presigned URL (1 hour)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onCopyUrl(item.key, 86400)}>
                      Presigned URL (1 day)
                    </DropdownMenuItem>
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
                      disabled={!isInteractive}
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
                  <DropdownMenuTrigger asChild disabled={!isInteractive}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => e.stopPropagation()}
                      disabled={!isInteractive}
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
                <DropdownMenuItem onClick={() => onCopy(item)}>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy to...
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMove(item)}>
                  <FolderInput className="h-4 w-4 mr-2" />
                  Move to...
                </DropdownMenuItem>
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
