import { useState } from 'react';
import { TableRow, TableCell, IconButton, Tooltip, Box, Typography, Checkbox, Menu, MenuItem, ListItemIcon, ListItemText } from '@mui/material';
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
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import type { S3Object } from '../../types';
import { formatFileSize, formatDate } from '../../utils/formatters';
import { getFileIconType, type FileIconType } from '../../utils/fileIcons';
import { FileDetailsDialog } from './FileDetailsDialog';

interface FileListItemProps {
  item: S3Object;
  onNavigate: (path: string) => void;
  onDownload: (key: string) => void;
  onCopyUrl: (key: string, ttl: number) => void;
  onCopyS3Uri: (key: string) => void;
  onDelete: (item: S3Object) => void;
  onCopy: (item: S3Object) => void;
  onMove: (item: S3Object) => void;
  onPreview: (item: S3Object) => void;
  isSelected?: boolean;
  onSelect?: (key: string, checked: boolean) => void;
  selectionMode?: boolean;
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
  onCopyS3Uri,
  onDelete,
  onCopy,
  onMove,
  onPreview,
  isSelected = false,
  onSelect,
  selectionMode = false,
}: FileListItemProps) {
  const iconType = getFileIconType(item.name, item.isFolder);
  const IconComponent = iconMap[iconType];
  const iconColor = iconColors[iconType];

  const handleClick = () => {
    if (item.isFolder) {
      onNavigate(item.key);
    } else {
      onPreview(item);
    }
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDownload(item.key);
  };

  const [linkMenuAnchor, setLinkMenuAnchor] = useState<null | HTMLElement>(null);
  const linkMenuOpen = Boolean(linkMenuAnchor);

  const handleLinkMenuOpen = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setLinkMenuAnchor(e.currentTarget);
  };

  const handleLinkMenuClose = () => {
    setLinkMenuAnchor(null);
  };

  const handleCopyUrl1Hour = () => {
    handleLinkMenuClose();
    onCopyUrl(item.key, 3600);
  };

  const handleCopyUrl1Day = () => {
    handleLinkMenuClose();
    onCopyUrl(item.key, 86400);
  };

  const handleCopyS3Uri = () => {
    handleLinkMenuClose();
    onCopyS3Uri(item.key);
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSelect?.(item.key, e.target.checked);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(menuAnchor);

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setMenuAnchor(e.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
  };

  const handleInfoClick = () => {
    handleMenuClose();
    setDetailsOpen(true);
  };

  const handleDetailsClose = () => {
    setDetailsOpen(false);
  };

  const handleMenuCopy = () => {
    handleMenuClose();
    onCopy(item);
  };

  const handleMenuMove = () => {
    handleMenuClose();
    onMove(item);
  };

  const handleMenuDelete = () => {
    handleMenuClose();
    onDelete(item);
  };

  return (
  <>
    <TableRow
      hover
      onClick={handleClick}
      selected={isSelected}
      sx={{
        cursor: 'pointer',
        '&:hover': {
          bgcolor: 'action.hover',
        },
      }}
    >
      {selectionMode && (
        <TableCell sx={{ width: 48, padding: '0 8px' }}>
          {onSelect && (
            <Checkbox
              size="small"
              checked={isSelected}
              onChange={handleCheckboxChange}
              onClick={handleCheckboxClick}
            />
          )}
        </TableCell>
      )}
      <TableCell sx={{ width: 48 }}>
        <IconComponent sx={{ color: iconColor, fontSize: 24 }} />
      </TableCell>
      <TableCell sx={{ minWidth: 120 }}>
        <Box>
          <Tooltip
            title={item.name + (item.isFolder ? '/' : '')}
            placement="bottom-start"
            enterDelay={500}
            enterTouchDelay={300}
          >
            <Typography
              variant="body2"
              sx={{
                fontWeight: item.isFolder ? 500 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'block',
                maxWidth: 'clamp(140px, 35vw, 320px)',
                '&:hover': item.isFolder ? { textDecoration: 'underline' } : {},
              }}
            >
              {item.name}
              {item.isFolder && '/'}
            </Typography>
          </Tooltip>
        </Box>
      </TableCell>
      <TableCell sx={{ width: { xs: 72, sm: 100 } }}>
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatFileSize(item.size)}
        </Typography>
      </TableCell>
      <TableCell sx={{ width: { xs: 120, sm: 180 } }}>
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDate(item.lastModified)}
        </Typography>
      </TableCell>
      <TableCell sx={{ width: 120 }} align="right">
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          {!item.isFolder && (
            <>
              <Tooltip title="Copy URL" placement="top-start">
                <IconButton size="small" onClick={handleLinkMenuOpen}>
                  <LinkIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Download" placement="top-start">
                <IconButton size="small" onClick={handleDownload}>
                  <DownloadIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          )}
          <Tooltip title="More actions" placement="top-start">
            <IconButton size="small" onClick={handleMenuOpen}>
              <MoreVertIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </TableCell>
    </TableRow>
    <Menu
      anchorEl={linkMenuAnchor}
      open={linkMenuOpen}
      onClose={handleLinkMenuClose}
      onClick={(e) => e.stopPropagation()}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      <MenuItem onClick={handleCopyUrl1Hour}>
        <ListItemText>Presigned URL (1 hour)</ListItemText>
      </MenuItem>
      <MenuItem onClick={handleCopyUrl1Day}>
        <ListItemText>Presigned URL (1 day)</ListItemText>
      </MenuItem>
      <MenuItem onClick={handleCopyS3Uri}>
        <ListItemText>S3 URI (s3://...)</ListItemText>
      </MenuItem>
    </Menu>
    <Menu
      anchorEl={menuAnchor}
      open={menuOpen}
      onClose={handleMenuClose}
      onClick={(e) => e.stopPropagation()}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      <MenuItem onClick={handleInfoClick}>
        <ListItemIcon>
          <InfoOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Details</ListItemText>
      </MenuItem>
      <MenuItem onClick={handleMenuCopy}>
        <ListItemIcon>
          <ContentCopyIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Copy to...</ListItemText>
      </MenuItem>
      <MenuItem onClick={handleMenuMove}>
        <ListItemIcon>
          <DriveFileMoveIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Move to...</ListItemText>
      </MenuItem>
      <MenuItem onClick={handleMenuDelete} sx={{ color: 'error.main' }}>
        <ListItemIcon sx={{ color: 'error.main' }}>
          <DeleteIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{item.isFolder ? 'Delete folder and contents' : 'Delete'}</ListItemText>
      </MenuItem>
    </Menu>
    <FileDetailsDialog open={detailsOpen} item={item} onClose={handleDetailsClose} />
  </>
  );
}
