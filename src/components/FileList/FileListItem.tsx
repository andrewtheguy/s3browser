import { TableRow, TableCell, IconButton, Tooltip, Box, Typography, Checkbox } from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import ImageIcon from '@mui/icons-material/Image';
import VideoFileIcon from '@mui/icons-material/VideoFile';
import AudioFileIcon from '@mui/icons-material/AudioFile';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import DescriptionIcon from '@mui/icons-material/Description';
import TableChartIcon from '@mui/icons-material/TableChart';
import FolderZipIcon from '@mui/icons-material/FolderZip';
import CodeIcon from '@mui/icons-material/Code';
import TextSnippetIcon from '@mui/icons-material/TextSnippet';
import DownloadIcon from '@mui/icons-material/Download';
import LinkIcon from '@mui/icons-material/Link';
import DeleteIcon from '@mui/icons-material/Delete';
import type { S3Object } from '../../types';
import { formatFileSize, formatDate } from '../../utils/formatters';
import { getFileIconType, type FileIconType } from '../../utils/fileIcons';

interface FileListItemProps {
  item: S3Object;
  onNavigate: (path: string) => void;
  onDownload: (key: string) => void;
  onCopyUrl: (key: string) => void;
  onDelete: (item: S3Object) => void;
  isSelected?: boolean;
  onSelect?: (key: string, checked: boolean) => void;
}

const iconMap: Record<FileIconType, React.ElementType> = {
  folder: FolderIcon,
  image: ImageIcon,
  video: VideoFileIcon,
  audio: AudioFileIcon,
  pdf: PictureAsPdfIcon,
  document: DescriptionIcon,
  spreadsheet: TableChartIcon,
  archive: FolderZipIcon,
  code: CodeIcon,
  text: TextSnippetIcon,
  file: InsertDriveFileIcon,
};

const iconColors: Record<FileIconType, string> = {
  folder: '#f9a825',
  image: '#43a047',
  video: '#e53935',
  audio: '#8e24aa',
  pdf: '#c62828',
  document: '#1565c0',
  spreadsheet: '#2e7d32',
  archive: '#6d4c41',
  code: '#00897b',
  text: '#546e7a',
  file: '#78909c',
};

export function FileListItem({
  item,
  onNavigate,
  onDownload,
  onCopyUrl,
  onDelete,
  isSelected = false,
  onSelect,
}: FileListItemProps) {
  const iconType = getFileIconType(item.name, item.isFolder);
  const IconComponent = iconMap[iconType];
  const iconColor = iconColors[iconType];

  const handleClick = () => {
    if (item.isFolder) {
      onNavigate(item.key);
    }
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDownload(item.key);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(item);
  };

  const handleCopyUrl = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCopyUrl(item.key);
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSelect?.(item.key, e.target.checked);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <TableRow
      hover
      onClick={handleClick}
      selected={isSelected}
      sx={{
        cursor: item.isFolder ? 'pointer' : 'default',
        '&:hover': {
          bgcolor: 'action.hover',
        },
      }}
    >
      <TableCell sx={{ width: 48, padding: '0 8px' }}>
        {!item.isFolder && onSelect ? (
          <Checkbox
            size="small"
            checked={isSelected}
            onChange={handleCheckboxChange}
            onClick={handleCheckboxClick}
          />
        ) : null}
      </TableCell>
      <TableCell sx={{ width: 48 }}>
        <IconComponent sx={{ color: iconColor, fontSize: 24 }} />
      </TableCell>
      <TableCell>
        <Box>
          <Typography
            variant="body2"
            sx={{
              fontWeight: item.isFolder ? 500 : 400,
              '&:hover': item.isFolder ? { textDecoration: 'underline' } : {},
            }}
          >
            {item.name}
            {item.isFolder && '/'}
          </Typography>
        </Box>
      </TableCell>
      <TableCell sx={{ width: 100 }}>
        <Typography variant="body2" color="text.secondary">
          {formatFileSize(item.size)}
        </Typography>
      </TableCell>
      <TableCell sx={{ width: 180 }}>
        <Typography variant="body2" color="text.secondary">
          {formatDate(item.lastModified)}
        </Typography>
      </TableCell>
      <TableCell sx={{ width: 100 }} align="right">
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          {!item.isFolder && (
            <>
              <Tooltip title="Copy presigned URL (24h)">
                <IconButton size="small" onClick={handleCopyUrl}>
                  <LinkIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Download">
                <IconButton size="small" onClick={handleDownload}>
                  <DownloadIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          )}
          <Tooltip title={item.isFolder ? "Delete folder (must be empty)" : "Delete"}>
            <IconButton size="small" onClick={handleDelete} color="error">
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </TableCell>
    </TableRow>
  );
}
