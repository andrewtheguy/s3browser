import { ChevronLeft, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { S3Object } from '../../types';
import type { EmbedType } from '../../utils/previewUtils';
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
  onBack: () => void;
  onDownload: (key: string, versionId?: string) => void;
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
  onBack,
  onDownload,
}: PreviewPanelProps) {
  const handleDownload = () => {
    if (item) {
      onDownload(item.key, item.versionId);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 sm:px-6 py-3 border-b shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 shrink-0">
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <span className="flex-1 truncate text-sm font-medium" title={fileName}>
          {fileName}
        </span>
        {!cannotPreviewReason && item && (
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
    </div>
  );
}
