import {
  File,
  X,
  CheckCircle,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { memo, useMemo, type CSSProperties, type ReactElement } from 'react';
import { List } from 'react-window';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { UploadProgress as UploadProgressType } from '../../types';
import type { CompletedStats } from '../../hooks';
import { formatFileSize } from '../../utils/formatters';

interface UploadProgressProps {
  uploads: UploadProgressType[];
  completedStats: CompletedStats;
  onCancel: (id: string) => void;
  onRetry?: (id: string) => void;
}

interface UploadRowData {
  uploads: UploadProgressType[];
  onCancel: (id: string) => void;
  onRetry?: (id: string) => void;
}

const ITEM_HEIGHT = 88;
const MAX_LIST_HEIGHT = 300;

type UploadRowComponentProps = UploadRowData & {
  index: number;
  style: CSSProperties;
  ariaAttributes: {
    'aria-posinset': number;
    'aria-setsize': number;
    role: 'listitem';
  };
  isScrolling?: boolean;
};

const UploadRowBase = ({
  index,
  style,
  ariaAttributes,
  uploads,
  onCancel,
  onRetry,
}: UploadRowComponentProps) => {
  const upload = uploads[index];
  if (!upload) return null;
  const displayName = upload.relativePath || upload.fileName;

  return (
    <div style={style} className="pr-1">
      <div
        {...ariaAttributes}
        className="flex items-start gap-3 bg-muted/50 rounded-lg p-3 h-[88px]"
      >
        <div className="flex-shrink-0 mt-0.5">
          {upload.status === 'error' ? (
            <AlertCircle className="h-5 w-5 text-destructive" />
          ) : (
            <File className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex-grow min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-sm truncate max-w-[180px]">
                  {displayName}
                </span>
              </TooltipTrigger>
              <TooltipContent>{displayName}</TooltipContent>
            </Tooltip>
            <Badge variant="secondary" className="text-xs">
              {formatFileSize(upload.total)}
            </Badge>
            {upload.isMultipart && upload.totalParts && (
              <Badge variant="outline" className="text-xs">
                Part {upload.completedParts || 0}/{upload.totalParts}
              </Badge>
            )}
          </div>
          <div className="mt-1">
            {upload.status === 'error' ? (
              <span className="text-xs text-destructive">
                {upload.error}
              </span>
            ) : upload.status === 'uploading' ? (
              <div className="flex items-center gap-2">
                <Progress value={upload.percentage} className="h-2 flex-grow" />
                <span className="text-xs text-muted-foreground min-w-[35px]">
                  {upload.percentage}%
                </span>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                Pending
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1 flex-shrink-0">
          {upload.status === 'error' && onRetry && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Retry upload"
                  onClick={() => onRetry(upload.id)}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Retry</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Cancel upload"
                onClick={() => onCancel(upload.id)}
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Cancel</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

const UploadRow = memo(UploadRowBase) as (props: UploadRowComponentProps) => ReactElement | null;

export const UploadProgress = memo(function UploadProgress({
  uploads,
  completedStats,
  onCancel,
  onRetry,
}: UploadProgressProps) {
  const activeUploads = useMemo(
    () => uploads.filter((upload) => upload.status !== 'completed'),
    [uploads]
  );
  const shouldVirtualize = activeUploads.length >= 100;
  const listHeight = useMemo(
    () => Math.min(MAX_LIST_HEIGHT, activeUploads.length * ITEM_HEIGHT),
    [activeUploads.length]
  );
  const listData = useMemo<UploadRowData>(
    () => ({ uploads: activeUploads, onCancel, onRetry }),
    [activeUploads, onCancel, onRetry]
  );

  if (activeUploads.length === 0 && completedStats.count === 0) {
    return null;
  }

  return (
    <TooltipProvider>
      <div className="mt-4">
        {/* Completed uploads summary */}
        {completedStats.count > 0 && (
          <Alert variant="success" className="mb-3 py-2">
            <CheckCircle className="h-4 w-4" />
            <AlertDescription>
              {completedStats.count} file{completedStats.count !== 1 ? 's' : ''} completed ({formatFileSize(completedStats.size)})
            </AlertDescription>
          </Alert>
        )}

        {/* Active uploads list */}
        {activeUploads.length > 0 && (
          <>
            <h3 className="text-sm font-medium mb-2">
              Uploads ({activeUploads.length})
            </h3>
            <div className="max-h-[300px] overflow-y-auto">
              {shouldVirtualize ? (
                <List<UploadRowData>
                  defaultHeight={listHeight}
                  rowCount={activeUploads.length}
                  rowHeight={ITEM_HEIGHT}
                  rowComponent={UploadRow as (props: UploadRowComponentProps) => ReactElement | null}
                  rowProps={listData}
                  style={{ height: listHeight, width: '100%' }}
                />
              ) : (
                <div role="list" className="space-y-2">
                  {activeUploads.map((upload) => {
                    const displayName = upload.relativePath || upload.fileName;
                    return (
                      <div
                        role="listitem"
                        key={upload.id}
                        className="flex items-start gap-3 bg-muted/50 rounded-lg p-3"
                      >
                        <div className="flex-shrink-0 mt-0.5">
                          {upload.status === 'error' ? (
                            <AlertCircle className="h-5 w-5 text-destructive" />
                          ) : (
                            <File className="h-5 w-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-grow min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-sm truncate max-w-[180px]">
                                  {displayName}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{displayName}</TooltipContent>
                            </Tooltip>
                            <Badge variant="secondary" className="text-xs">
                              {formatFileSize(upload.total)}
                            </Badge>
                            {upload.isMultipart && upload.totalParts && (
                              <Badge variant="outline" className="text-xs">
                                Part {upload.completedParts || 0}/{upload.totalParts}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1">
                            {upload.status === 'error' ? (
                              <span className="text-xs text-destructive">
                                {upload.error}
                              </span>
                            ) : upload.status === 'uploading' ? (
                              <div className="flex items-center gap-2">
                                <Progress value={upload.percentage} className="h-2 flex-grow" />
                                <span className="text-xs text-muted-foreground min-w-[35px]">
                                  {upload.percentage}%
                                </span>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Pending
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          {upload.status === 'error' && onRetry && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  aria-label="Retry upload"
                                  onClick={() => onRetry(upload.id)}
                                >
                                  <RefreshCw className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Retry</TooltipContent>
                            </Tooltip>
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                aria-label="Cancel upload"
                                onClick={() => onCancel(upload.id)}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Cancel</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  );
});
