import { useState, useCallback } from 'react';
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
import RefreshIcon from '@mui/icons-material/Refresh';
import type { S3Object } from '../../types';
import type { EmbedType } from '../../utils/previewUtils';

interface PreviewDialogProps {
  open: boolean;
  isLoading: boolean;
  error: string | null;
  signedUrl: string | null;
  embedType: EmbedType;
  item: S3Object | null;
  cannotPreviewReason: string | null;
  onClose: () => void;
  onDownload: (key: string) => void;
}

export function PreviewDialog({
  open,
  isLoading,
  error,
  signedUrl,
  embedType,
  item,
  cannotPreviewReason,
  onClose,
  onDownload,
}: PreviewDialogProps) {
  // Track error with the URL that caused it, so error auto-clears when URL changes
  const [mediaError, setMediaError] = useState<{ url: string; message: string } | null>(null);

  // Only show error if it's for the current signedUrl
  const mediaLoadError = mediaError?.url === signedUrl ? mediaError.message : null;

  const handleDownload = () => {
    if (item) {
      onDownload(item.key);
    }
  };

  const handleMediaError = useCallback(
    (mediaType: 'video' | 'audio') => {
      if (signedUrl) {
        console.error(`Failed to load ${mediaType}:`, signedUrl);
        setMediaError({
          url: signedUrl,
          message: `${mediaType === 'video' ? 'Video' : 'Audio'} failed to load`,
        });
      }
    },
    [signedUrl]
  );

  const handleRetry = useCallback(() => {
    setMediaError(null);
  }, []);

  const renderMediaError = () => (
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
        {mediaLoadError}
      </Typography>
      <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 2 }}>
        The file could not be played. Try again or download the file.
      </Typography>
      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button variant="outlined" startIcon={<RefreshIcon />} onClick={handleRetry}>
          Retry
        </Button>
        <Button variant="contained" startIcon={<DownloadIcon />} onClick={handleDownload} disabled={!item}>
          Download
        </Button>
      </Box>
    </Box>
  );

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

    if (signedUrl !== null) {
      if (embedType === 'image') {
        return (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              p: 2,
              bgcolor: (theme) =>
                theme.palette.mode === 'dark' ? theme.palette.background.paper : 'grey.50',
            }}
          >
            <Box
              component="img"
              src={signedUrl}
              alt={item?.name || 'Preview'}
              sx={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
              }}
            />
          </Box>
        );
      }

      if (embedType === 'video') {
        if (mediaLoadError) {
          return renderMediaError();
        }
        return (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              p: 2,
              bgcolor: (theme) =>
                theme.palette.mode === 'dark' ? theme.palette.background.paper : 'grey.50',
            }}
          >
            <Box
              component="video"
              controls
              src={signedUrl}
              onError={() => handleMediaError('video')}
              sx={{
                maxWidth: '100%',
                maxHeight: '100%',
              }}
            />
          </Box>
        );
      }

      if (embedType === 'audio') {
        if (mediaLoadError) {
          return renderMediaError();
        }
        return (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              p: 2,
            }}
          >
            <Box
              component="audio"
              controls
              src={signedUrl}
              onError={() => handleMediaError('audio')}
              sx={{ width: '100%', maxWidth: 500 }}
            />
          </Box>
        );
      }

      // For text and PDF, use iframe
      return (
        <Box
          component="iframe"
          src={signedUrl}
          title={item?.name || 'Preview'}
          sx={{
            width: '100%',
            height: '100%',
            border: 'none',
          }}
        />
      );
    }

    return null;
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      PaperProps={{
        sx: {
          width: 'calc(100vw - 64px)',
          height: 'calc(100vh - 64px)',
          maxWidth: 'calc(100vw - 64px)',
          maxHeight: 'calc(100vh - 64px)',
          m: 4,
          display: 'flex',
          flexDirection: 'column',
        },
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
