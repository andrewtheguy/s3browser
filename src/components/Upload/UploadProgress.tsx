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
} from '@mui/material';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import type { UploadProgress as UploadProgressType } from '../../types';
import { formatFileSize } from '../../utils/formatters';

interface UploadProgressProps {
  uploads: UploadProgressType[];
  onCancel: (key: string) => void;
}

export function UploadProgress({ uploads, onCancel }: UploadProgressProps) {
  if (uploads.length === 0) {
    return null;
  }

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        Uploads ({uploads.length})
      </Typography>
      <List dense>
        {uploads.map((upload) => (
          <ListItem
            key={upload.key}
            secondaryAction={
              upload.status === 'uploading' ? (
                <IconButton
                  edge="end"
                  size="small"
                  onClick={() => onCancel(upload.key)}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              ) : null
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
              ) : (
                <InsertDriveFileIcon />
              )}
            </ListItemIcon>
            <ListItemText
              primary={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" noWrap sx={{ maxWidth: 200 }}>
                    {upload.file.name}
                  </Typography>
                  <Chip
                    size="small"
                    label={formatFileSize(upload.total)}
                    sx={{ fontSize: '0.7rem' }}
                  />
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
        ))}
      </List>
    </Box>
  );
}
