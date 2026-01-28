import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import {
  Box,
  Breadcrumbs,
  Link,
  Typography,
  Button,
  IconButton,
  Tooltip,
  Chip,
} from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import RefreshIcon from '@mui/icons-material/Refresh';
import LogoutIcon from '@mui/icons-material/Logout';
import { useBrowserContext, useS3ClientContext } from '../../contexts';

interface ToolbarProps {
  onUploadClick: () => void;
  onCreateFolderClick: () => void;
}

export function Toolbar({ onUploadClick, onCreateFolderClick }: ToolbarProps) {
  const navigate = useNavigate();
  const { credentials, disconnect } = useS3ClientContext();
  const { pathSegments, navigateTo, refresh, isLoading } = useBrowserContext();

  const handleDisconnect = useCallback(async () => {
    try {
      await disconnect();
    } catch (error) {
      console.error('Disconnect failed:', error);
    } finally {
      void navigate('/');
    }
  }, [disconnect, navigate]);

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      navigateTo('');
    } else {
      const path = pathSegments.slice(0, index + 1).join('/') + '/';
      navigateTo(path);
    }
  };

  return (
    <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 2,
        }}
      >
        <Tooltip title="Click to change bucket">
          <Chip
            label={`Bucket: ${credentials?.bucket ?? '—'}`}
            color="primary"
            variant="outlined"
            onClick={() => void navigate('/')}
            sx={{ fontWeight: 500, cursor: 'pointer' }}
          />
        </Tooltip>

        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Refresh">
            <IconButton onClick={refresh} disabled={isLoading}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <Button
            variant="outlined"
            startIcon={<CreateNewFolderIcon />}
            onClick={onCreateFolderClick}
          >
            New Folder
          </Button>
          <Button
            variant="contained"
            startIcon={<CloudUploadIcon />}
            onClick={onUploadClick}
          >
            Upload
          </Button>
          <Tooltip title="Disconnect">
            <IconButton onClick={handleDisconnect} color="error">
              <LogoutIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Breadcrumbs aria-label="breadcrumb">
        <Link
          component="button"
          underline="hover"
          sx={{
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
          }}
          color={pathSegments.length === 0 ? 'text.primary' : 'inherit'}
          onClick={() => handleBreadcrumbClick(-1)}
        >
          <HomeIcon sx={{ mr: 0.5, fontSize: 20 }} />
          Home
        </Link>

        {pathSegments.map((segment, index) => {
          const isLast = index === pathSegments.length - 1;

          if (isLast) {
            return (
              <Typography key={index} color="text.primary" fontWeight={500}>
                {segment}
              </Typography>
            );
          }

          return (
            <Link
              key={index}
              component="button"
              underline="hover"
              color="inherit"
              onClick={() => handleBreadcrumbClick(index)}
              sx={{ cursor: 'pointer' }}
            >
              {segment}
            </Link>
          );
        })}
      </Breadcrumbs>
    </Box>
  );
}
