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
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { S3Object } from '../../types';
import { formatFileSizeDetailed, formatDate } from '../../utils/formatters';

interface FileDetailsDialogProps {
  open: boolean;
  item: S3Object | null;
  onClose: () => void;
}

export function FileDetailsDialog({ open, item, onClose }: FileDetailsDialogProps) {
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
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
