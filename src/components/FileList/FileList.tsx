import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Box,
  Typography,
  Skeleton,
  Alert,
} from '@mui/material';
import FolderOffIcon from '@mui/icons-material/FolderOff';
import { useBrowserContext } from '../../contexts';
import { useDownload } from '../../hooks';
import { FileListItem } from './FileListItem';
import type { S3Object } from '../../types';

interface FileListProps {
  onDeleteRequest: (item: S3Object) => void;
}

export function FileList({ onDeleteRequest }: FileListProps) {
  const { objects, isLoading, error, navigateTo } = useBrowserContext();
  const { download } = useDownload();

  const handleDownload = async (key: string) => {
    try {
      await download(key);
    } catch {
      // Error is handled by hook
    }
  };

  if (error) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {error}
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <TableContainer component={Paper} elevation={0}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 48 }} />
              <TableCell>Name</TableCell>
              <TableCell sx={{ width: 100 }}>Size</TableCell>
              <TableCell sx={{ width: 180 }}>Last Modified</TableCell>
              <TableCell sx={{ width: 100 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {[...Array(5)].map((_, index) => (
              <TableRow key={index}>
                <TableCell>
                  <Skeleton variant="circular" width={24} height={24} />
                </TableCell>
                <TableCell>
                  <Skeleton variant="text" width="60%" />
                </TableCell>
                <TableCell>
                  <Skeleton variant="text" width="80%" />
                </TableCell>
                <TableCell>
                  <Skeleton variant="text" width="80%" />
                </TableCell>
                <TableCell>
                  <Skeleton variant="text" width={60} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    );
  }

  if (objects.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          py: 8,
          color: 'text.secondary',
        }}
      >
        <FolderOffIcon sx={{ fontSize: 64, mb: 2, opacity: 0.5 }} />
        <Typography variant="h6">This folder is empty</Typography>
        <Typography variant="body2">
          Upload files or create a new folder to get started
        </Typography>
      </Box>
    );
  }

  return (
    <TableContainer component={Paper} elevation={0}>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 48 }} />
            <TableCell>Name</TableCell>
            <TableCell sx={{ width: 100 }}>Size</TableCell>
            <TableCell sx={{ width: 180 }}>Last Modified</TableCell>
            <TableCell sx={{ width: 100 }} align="right">
              Actions
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {objects.map((item) => (
            <FileListItem
              key={item.key}
              item={item}
              onNavigate={navigateTo}
              onDownload={handleDownload}
              onDelete={onDeleteRequest}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
