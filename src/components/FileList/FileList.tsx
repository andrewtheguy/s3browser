import { useCallback } from 'react';
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
  Checkbox,
} from '@mui/material';
import FolderOffIcon from '@mui/icons-material/FolderOff';
import { useBrowserContext } from '../../contexts';
import { useDownload } from '../../hooks';
import { FileListItem } from './FileListItem';
import type { S3Object } from '../../types';

interface FileListProps {
  onDeleteRequest: (item: S3Object) => void;
  onCopyUrl: (key: string) => void;
  onPreview: (item: S3Object) => void;
  selectedKeys: Set<string>;
  onSelectItem: (key: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  allowFolderSelect?: boolean;
  allowRecursiveDelete?: boolean;
}

export function FileList({
  onDeleteRequest,
  onCopyUrl,
  onPreview,
  selectedKeys,
  onSelectItem,
  onSelectAll,
  allowFolderSelect = false,
  allowRecursiveDelete = false,
}: FileListProps) {
  const { objects, isLoading, error, navigateTo } = useBrowserContext();

  const selectableItems = allowFolderSelect ? objects : objects.filter((item) => !item.isFolder);
  const selectableCount = selectableItems.length;
  const selectedCount = selectableItems.filter((item) => selectedKeys.has(item.key)).length;
  const isAllSelected = selectableCount > 0 && selectedCount === selectableCount;
  const isIndeterminate = selectedCount > 0 && selectedCount < selectableCount;
  const { download } = useDownload();

  const handleDownload = useCallback(
    (key: string) => {
      void download(key);
    },
    [download]
  );

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
              <TableCell sx={{ width: 48, padding: '0 8px' }} />
              <TableCell sx={{ width: 48 }} />
              <TableCell>Name</TableCell>
              <TableCell sx={{ width: 100 }}>Size</TableCell>
              <TableCell sx={{ width: 180 }}>Last Modified</TableCell>
              <TableCell sx={{ width: 100 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {Array.from({ length: 5 }).map((_, index) => (
              <TableRow key={index}>
                <TableCell sx={{ padding: '0 8px' }}>
                  <Skeleton variant="rectangular" width={20} height={20} />
                </TableCell>
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
      <Table sx={{ tableLayout: 'fixed' }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 48, padding: '0 8px' }}>
              {selectableCount > 0 && (
                <Checkbox
                  size="small"
                  checked={isAllSelected}
                  indeterminate={isIndeterminate}
                  onChange={(e) => onSelectAll(e.target.checked)}
                />
              )}
            </TableCell>
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
              onCopyUrl={onCopyUrl}
              onDelete={onDeleteRequest}
              onPreview={onPreview}
              isSelected={selectedKeys.has(item.key)}
              onSelect={onSelectItem}
              allowFolderSelect={allowFolderSelect}
              allowRecursiveDelete={allowRecursiveDelete}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
