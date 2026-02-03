import { useState, useEffect } from 'react';
import { useParams } from 'react-router';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Spinner } from '@/components/ui/spinner';
import { useS3ClientContext } from '../../contexts';
import { getObjectMetadata, type ObjectMetadata } from '../../services/api/objects';
import type { S3Object } from '../../types';
import { formatFileSizeDetailed, formatDateFull } from '../../utils/formatters';

interface FileDetailsDialogProps {
  open: boolean;
  item: S3Object | null;
  onClose: () => void;
}

export function FileDetailsDialog({ open, item, onClose }: FileDetailsDialogProps) {
  const { activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;

  const [metadata, setMetadata] = useState<ObjectMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !item || item.isFolder || !activeConnectionId || !bucket) {
      setMetadata(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const abortController = new AbortController();
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const data = await getObjectMetadata(
          activeConnectionId,
          bucket,
          item.key,
          item.versionId,
          abortController.signal
        );
        if (!abortController.signal.aborted) {
          setMetadata(data);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load metadata');
        }
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [open, item, activeConnectionId, bucket]);

  if (!item) return null;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {item.isFolder ? 'Folder Details' : 'File Details'}
          </DialogTitle>
        </DialogHeader>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium w-[120px]">
                Name
              </TableCell>
              <TableCell className="break-all">
                {item.name}{item.isFolder ? '/' : ''}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">
                Full Path
              </TableCell>
              <TableCell className="break-all">
                {item.key}
              </TableCell>
            </TableRow>
            {!item.isFolder && (
              <>
                {(metadata?.versionId || item.versionId) && (
                  <TableRow>
                    <TableCell className="font-medium">
                      Version ID
                    </TableCell>
                    <TableCell className="break-all font-mono text-xs">
                      {metadata?.versionId ?? item.versionId}
                    </TableCell>
                  </TableRow>
                )}
                <TableRow>
                  <TableCell className="font-medium">
                    Size
                  </TableCell>
                  <TableCell>
                    {formatFileSizeDetailed(item.size)}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">
                    Last Modified
                  </TableCell>
                  <TableCell>
                    {formatDateFull(item.lastModified)}
                  </TableCell>
                </TableRow>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={2}>
                      <div className="flex items-center gap-2">
                        <Spinner size="sm" />
                        <span className="text-sm text-muted-foreground">
                          Loading metadata...
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : error ? (
                  <TableRow>
                    <TableCell colSpan={2}>
                      <span className="text-sm text-destructive">
                        {error}
                      </span>
                    </TableCell>
                  </TableRow>
                ) : metadata && (
                  <>
                    {metadata.contentType && (
                      <TableRow>
                        <TableCell className="font-medium">
                          Content Type
                        </TableCell>
                        <TableCell>
                          {metadata.contentType}
                        </TableCell>
                      </TableRow>
                    )}
                    {metadata.storageClass && (
                      <TableRow>
                        <TableCell className="font-medium">
                          Storage Class
                        </TableCell>
                        <TableCell>
                          {metadata.storageClass}
                        </TableCell>
                      </TableRow>
                    )}
                    <TableRow>
                      <TableCell className="font-medium">
                        Encryption
                      </TableCell>
                      <TableCell>
                        {metadata.serverSideEncryption
                          || metadata.sseCustomerAlgorithm
                          || (metadata.vendor === 'aws' || metadata.vendor === 'b2' ? 'None' : 'Unknown')}
                      </TableCell>
                    </TableRow>
                    {metadata.sseKmsKeyId && (
                      <TableRow>
                        <TableCell className="font-medium">
                          KMS Key ID
                        </TableCell>
                        <TableCell className="break-all font-mono text-xs">
                          {metadata.sseKmsKeyId}
                        </TableCell>
                      </TableRow>
                    )}
                    {item.etag && (
                      <TableRow>
                        <TableCell className="font-medium">
                          ETag
                        </TableCell>
                        <TableCell className="break-all font-mono text-xs">
                          {item.etag}
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                )}
              </>
            )}
          </TableBody>
        </Table>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
