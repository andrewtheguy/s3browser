import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  CircularProgress,
  IconButton,
  Alert,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import type { S3Object } from '../../types';

interface PreviewDialogProps {
  open: boolean;
  isLoading: boolean;
  error: string | null;
  content: string | null;
  item: S3Object | null;
  cannotPreviewReason: string | null;
  onClose: () => void;
  onDownload: (key: string) => void;
}

export function PreviewDialog({
  open,
  isLoading,
  error,
  content,
  item,
  cannotPreviewReason,
  onClose,
  onDownload,
}: PreviewDialogProps) {
  const handleDownload = () => {
    if (item) {
      onDownload(item.key);
    }
  };

  const renderContent = () => {
    if (isLoading) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
          }}
        >
          <CircularProgress />
        </Box>
      );
    }

    if (error) {
      return (
        <Box sx={{ p: 2 }}>
          <Alert severity="error">{error}</Alert>
        </Box>
      );
    }

    if (cannotPreviewReason) {
      return (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'text.secondary',
            p: 4,
          }}
        >
          <InsertDriveFileIcon sx={{ fontSize: 64, mb: 2, opacity: 0.5 }} />
          <Typography variant="h6" gutterBottom>
            Cannot Preview File
          </Typography>
          <Typography variant="body2" color="text.secondary" align="center">
            {cannotPreviewReason}
          </Typography>
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            onClick={handleDownload}
            disabled={!item}
            sx={{ mt: 3 }}
          >
            Download File
          </Button>
        </Box>
      );
    }

    if (content !== null) {
      return (
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 2,
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            bgcolor: 'grey.50',
            minHeight: '100%',
          }}
        >
          {content}
        </Box>
      );
    }

    return null;
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: { height: '80vh', display: 'flex', flexDirection: 'column' },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography
          variant="h6"
          component="span"
          sx={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            mr: 2,
          }}
        >
          {item?.name || 'Preview'}
        </Typography>
        <IconButton onClick={onClose} size="small" edge="end">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ flex: 1, overflow: 'auto', p: 0 }}>
        {renderContent()}
      </DialogContent>

      <DialogActions sx={{ borderTop: 1, borderColor: 'divider' }}>
        {!cannotPreviewReason && (
          <Button
            startIcon={<DownloadIcon />}
            onClick={handleDownload}
            disabled={!item}
          >
            Download
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
