import {
  File,
  X,
  CheckCircle,
  AlertCircle,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
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
import { formatFileSize } from '../../utils/formatters';

interface UploadProgressProps {
  uploads: UploadProgressType[];
  onCancel: (id: string) => void;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onRetry?: (id: string) => void;
}

export function UploadProgress({
  uploads,
  onCancel,
  onPause,
  onResume,
  onRetry,
}: UploadProgressProps) {
  if (uploads.length === 0) {
    return null;
  }

  return (
    <TooltipProvider>
      <div className="mt-4">
        <h3 className="text-sm font-medium mb-2">
          Uploads ({uploads.length})
        </h3>
        <ul className="space-y-2">
          {uploads.map((upload) => {
            const displayName = upload.relativePath || upload.fileName;
            return (
              <li
                key={upload.id}
                className="flex items-start gap-3 bg-muted/50 rounded-lg p-3"
              >
                <div className="flex-shrink-0 mt-0.5">
                  {upload.status === 'completed' ? (
                    <CheckCircle className="h-5 w-5 text-green-500" />
                  ) : upload.status === 'error' ? (
                    <AlertCircle className="h-5 w-5 text-destructive" />
                  ) : upload.status === 'paused' ? (
                    <Pause className="h-5 w-5 text-yellow-500" />
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
                    ) : upload.status === 'paused' ? (
                      <div className="flex items-center gap-2">
                        <Progress value={upload.percentage} className="h-2 flex-grow [&>div]:bg-yellow-500" />
                        <span className="text-xs text-yellow-600 min-w-[50px]">
                          Paused
                        </span>
                      </div>
                    ) : upload.status === 'completed' ? (
                      <span className="text-xs text-green-600">
                        Completed
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Pending
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {upload.status === 'uploading' && upload.isMultipart && onPause && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => onPause(upload.id)}
                        >
                          <Pause className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Pause</TooltipContent>
                    </Tooltip>
                  )}
                  {upload.status === 'paused' && onResume && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => onResume(upload.id)}
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Resume</TooltipContent>
                    </Tooltip>
                  )}
                  {upload.status === 'error' && onRetry && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => onRetry(upload.id)}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Retry</TooltipContent>
                    </Tooltip>
                  )}
                  {(upload.status === 'uploading' ||
                    upload.status === 'paused' ||
                    upload.status === 'error' ||
                    upload.status === 'pending') && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => onCancel(upload.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Cancel</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </TooltipProvider>
  );
}
