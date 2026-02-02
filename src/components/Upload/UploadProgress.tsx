import {
  Box,
  Typography,
  LinearProgress,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Chip,
  Tooltip,
} from '@mui/material';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
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
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        Uploads ({uploads.length})
      </Typography>
      <List dense>
        {uploads.map((upload) => {
          const displayName = upload.relativePath || upload.fileName;
          return (
            <ListItem
              key={upload.id}
              secondaryAction={
                <Box sx={{ display: 'flex', gap: 0.5 }}>
                {upload.status === 'uploading' && upload.isMultipart && onPause && (
                  <Tooltip title="Pause">
                    <span>
                      <IconButton
                        edge="end"
                        size="small"
                        onClick={() => onPause(upload.id)}
                      >
                        <PauseIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                {upload.status === 'paused' && onResume && (
                  <Tooltip title="Resume">
                    <span>
                      <IconButton
                        edge="end"
                        size="small"
                        onClick={() => onResume(upload.id)}
                      >
                        <PlayArrowIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                {upload.status === 'error' && onRetry && (
                  <Tooltip title="Retry">
                    <span>
                      <IconButton
                        edge="end"
                        size="small"
                        onClick={() => onRetry(upload.id)}
                      >
                        <RefreshIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                {(upload.status === 'uploading' ||
                  upload.status === 'paused' ||
                  upload.status === 'error' ||
                  upload.status === 'pending') && (
                  <Tooltip title="Cancel">
                    <span>
                      <IconButton
                        edge="end"
                        size="small"
                        onClick={() => onCancel(upload.id)}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                </Box>
              }
              sx={{
                bgcolor: 'background.default',
                borderRadius: 1,
                mb: 1,
              }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>
                {upload.status === 'completed' ? (
                  <CheckCircleIcon color="success" />
                ) : upload.status === 'error' ? (
                  <ErrorIcon color="error" />
                ) : upload.status === 'paused' ? (
                  <PauseIcon color="warning" />
                ) : (
                  <InsertDriveFileIcon />
                )}
              </ListItemIcon>
              <ListItemText
                disableTypography
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Tooltip title={displayName} placement="top" arrow>
                      <Typography variant="body2" noWrap sx={{ maxWidth: 180 }}>
                        {displayName}
                      </Typography>
                    </Tooltip>
                    <Chip
                      size="small"
                      label={formatFileSize(upload.total)}
                      sx={{ fontSize: '0.7rem' }}
                    />
                    {upload.isMultipart && upload.totalParts && (
                      <Chip
                        size="small"
                        label={`Part ${upload.completedParts || 0}/${upload.totalParts}`}
                        color="primary"
                        variant="outlined"
                        sx={{ fontSize: '0.7rem' }}
                      />
                    )}
                  </Box>
                }
                secondary={
                  upload.status === 'error' ? (
                    <Typography variant="caption" color="error">
                      {upload.error}
                    </Typography>
                  ) : upload.status === 'uploading' ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                      <LinearProgress
                        variant="determinate"
                        value={upload.percentage}
                        sx={{ flexGrow: 1 }}
                      />
                      <Typography variant="caption" sx={{ minWidth: 35 }}>
                        {upload.percentage}%
                      </Typography>
                    </Box>
                  ) : upload.status === 'paused' ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                      <LinearProgress
                        variant="determinate"
                        value={upload.percentage}
                        color="warning"
                        sx={{ flexGrow: 1 }}
                      />
                      <Typography variant="caption" color="warning.main" sx={{ minWidth: 50 }}>
                        Paused
                      </Typography>
                    </Box>
                  ) : upload.status === 'completed' ? (
                    <Typography variant="caption" color="success.main">
                      Completed
                    </Typography>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      Pending
                    </Typography>
                  )
                }
              />
            </ListItem>
          );
        })}
      </List>
    </Box>
  );
}
