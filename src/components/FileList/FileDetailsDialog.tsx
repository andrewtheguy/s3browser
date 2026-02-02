import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Table,
  TableBody,
  TableRow,
  TableCell,
  IconButton,
  CircularProgress,
  Box,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../../contexts';
import { getObjectMetadata, type ObjectMetadata } from '../../services/api/objects';
import type { S3Object } from '../../types';
import { formatFileSizeDetailed, formatDate } from '../../utils/formatters';

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
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {item.isFolder ? 'Folder Details' : 'File Details'}
        <IconButton onClick={onClose} size="small" aria-label="close">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Table size="small">
          <TableBody>
            <TableRow>
              <TableCell component="th" sx={{ fontWeight: 500, width: 120 }}>
                Name
              </TableCell>
              <TableCell sx={{ wordBreak: 'break-all' }}>
                {item.name}{item.isFolder ? '/' : ''}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell component="th" sx={{ fontWeight: 500 }}>
                Full Path
              </TableCell>
              <TableCell sx={{ wordBreak: 'break-all' }}>
                {item.key}
              </TableCell>
            </TableRow>
            {!item.isFolder && (
              <>
                <TableRow>
                  <TableCell component="th" sx={{ fontWeight: 500 }}>
                    Size
                  </TableCell>
                  <TableCell>
                    {formatFileSizeDetailed(item.size)}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell component="th" sx={{ fontWeight: 500 }}>
                    Last Modified
                  </TableCell>
                  <TableCell>
                    {formatDate(item.lastModified)}
                  </TableCell>
                </TableRow>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={2}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <CircularProgress size={16} />
                        <Typography variant="body2" color="text.secondary">
                          Loading metadata...
                        </Typography>
                      </Box>
                    </TableCell>
                  </TableRow>
                ) : error ? (
                  <TableRow>
                    <TableCell colSpan={2}>
                      <Typography variant="body2" color="error">
                        {error}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : metadata && (
                  <>
                    {metadata.contentType && (
                      <TableRow>
                        <TableCell component="th" sx={{ fontWeight: 500 }}>
                          Content Type
                        </TableCell>
                        <TableCell>
                          {metadata.contentType}
                        </TableCell>
                      </TableRow>
                    )}
                    {metadata.storageClass && (
                      <TableRow>
                        <TableCell component="th" sx={{ fontWeight: 500 }}>
                          Storage Class
                        </TableCell>
                        <TableCell>
                          {metadata.storageClass}
                        </TableCell>
                      </TableRow>
                    )}
                    <TableRow>
                      <TableCell component="th" sx={{ fontWeight: 500 }}>
                        Encryption
                      </TableCell>
                      <TableCell>
                        {metadata.encryption ?? 'None'}
                      </TableCell>
                    </TableRow>
                    {item.etag && (
                      <TableRow>
                        <TableCell component="th" sx={{ fontWeight: 500 }}>
                          ETag
                        </TableCell>
                        <TableCell sx={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.85em' }}>
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
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
