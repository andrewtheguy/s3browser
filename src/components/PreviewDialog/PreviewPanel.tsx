import { useState } from 'react';
import { ChevronLeft, Download, Link, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import type { S3Object } from '../../types';
import type { EmbedType } from '../../utils/previewUtils';
import { usePresignedUrlTtlOptions } from '../../config';
import { FileDetailsDialog } from '../FileList/FileDetailsDialog';
import { PreviewBody } from './PreviewBody';

interface PreviewPanelProps {
  isLoading: boolean;
  error: string | null;
  signedUrl: string | null;
  textContent: string | null;
  embedType: EmbedType;
  item: S3Object | null;
  cannotPreviewReason: string | null;
  fileName: string;
  showVersions: boolean;
  onBack: () => void;
  onDownload: (key: string, versionId?: string) => void;
  onCopyUrl: (key: string, ttl: number, versionId?: string) => void;
  onCopyS3Uri: (key: string) => void;
}

export function PreviewPanel({
  isLoading,
  error,
  signedUrl,
  textContent,
  embedType,
  item,
  cannotPreviewReason,
  fileName,
  showVersions,
  onBack,
  onDownload,
  onCopyUrl,
  onCopyS3Uri,
}: PreviewPanelProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const ttlOptions = usePresignedUrlTtlOptions();

  const handleDownload = () => {
    if (item) {
      onDownload(item.key, item.versionId);
    }
  };

  const versionIdForUrl = showVersions ? item?.versionId : undefined;
  const showActions = item && !item.isFolder;

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1 sm:gap-2 px-4 sm:px-6 py-3 border-b shrink-0">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 shrink-0">
            <ChevronLeft className="h-4 w-4" />
            Back
          </Button>
          <span className="flex-1 truncate text-sm font-medium" title={fileName}>
            {fileName}
          </span>
          {showActions && (
            <>
              <div className="hidden sm:flex items-center gap-1">
                {ttlOptions.map((option) => (
                  <Tooltip key={option.shortLabel}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 gap-1 px-2"
                        onClick={() => onCopyUrl(item.key, option.ttl, versionIdForUrl)}
                      >
                        <Link className="h-4 w-4" />
                        {option.shortLabel}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy presigned URL ({option.longLabel})</TooltipContent>
                  </Tooltip>
                ))}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 gap-1 px-2"
                      onClick={() => onCopyS3Uri(item.key)}
                    >
                      <Link className="h-4 w-4" />
                      S3
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Copy S3 URI (s3://...)</TooltipContent>
                </Tooltip>
              </div>

              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 sm:hidden"
                      >
                        <Link className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Copy URL</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end">
                  {ttlOptions.map((option) => (
                    <DropdownMenuItem
                      key={option.shortLabel}
                      onClick={() => onCopyUrl(item.key, option.ttl, versionIdForUrl)}
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
                    className="h-8 w-8 shrink-0"
                    onClick={() => setDetailsOpen(true)}
                  >
                    <Info className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Details</TooltipContent>
              </Tooltip>

              {!cannotPreviewReason && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  className="shrink-0"
                >
                  <Download className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">Download</span>
                </Button>
              )}
            </>
          )}
        </div>
        <PreviewBody
          isLoading={isLoading}
          error={error}
          signedUrl={signedUrl}
          textContent={textContent}
          embedType={embedType}
          item={item}
          cannotPreviewReason={cannotPreviewReason}
          onDownload={onDownload}
        />
        <FileDetailsDialog
          open={detailsOpen}
          item={item}
          onClose={() => setDetailsOpen(false)}
        />
      </div>
    </TooltipProvider>
  );
}
