import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router';
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
import DeleteIcon from '@mui/icons-material/Delete';
import SettingsIcon from '@mui/icons-material/Settings';
import { useBrowserContext, useS3ClientContext } from '../../contexts';
import { buildSelectBucketUrl } from '../../utils/urlEncoding';

interface ToolbarProps {
  onUploadClick: () => void;
  onCreateFolderClick: () => void;
  selectedCount?: number;
  onBatchDelete?: () => void;
  isDeleting?: boolean;
}

export function Toolbar({ onUploadClick, onCreateFolderClick, selectedCount = 0, onBatchDelete, isDeleting = false }: ToolbarProps) {
  const navigate = useNavigate();
  const { connectionId } = useParams<{ connectionId?: string }>();
  const { credentials, disconnect, activeConnectionId } = useS3ClientContext();
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

  const handleManageConnections = useCallback(() => {
    void navigate('/');
  }, [navigate]);

  const handleChangeBucket = useCallback(() => {
    const parsedId = connectionId ? parseInt(connectionId, 10) : NaN;
    const connId = !isNaN(parsedId) && parsedId > 0 ? parsedId : activeConnectionId;

    if (!connId || connId <= 0) {
      console.error('Cannot change bucket: no valid connection ID available');
      void navigate('/');
      return;
    }

    void navigate(buildSelectBucketUrl(connId));
  }, [connectionId, activeConnectionId, navigate]);

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
            onClick={handleChangeBucket}
            sx={{ fontWeight: 500, cursor: 'pointer' }}
          />
        </Tooltip>

        <Box sx={{ display: 'flex', gap: { xs: 0.5, sm: 1 } }}>
          <Tooltip title="Refresh">
            <IconButton onClick={refresh} disabled={isLoading}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          {selectedCount > 0 && onBatchDelete && (
            <Tooltip title={isDeleting ? 'Deleting...' : `Delete ${selectedCount} item(s)`}>
              <Box component="span" sx={{ display: 'inline-block' }}>
                <Button
                  variant="outlined"
                  color="error"
                  onClick={onBatchDelete}
                  disabled={isDeleting}
                  sx={{ minWidth: 'auto', px: { xs: 1, sm: 2 } }}
                >
                  <DeleteIcon sx={{ mr: { xs: 0, sm: 1 } }} />
                  <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                    {isDeleting ? 'Deleting...' : `Delete (${selectedCount})`}
                  </Box>
                </Button>
              </Box>
            </Tooltip>
          )}
          <Tooltip title="New Folder">
            <Button
              variant="outlined"
              onClick={onCreateFolderClick}
              sx={{ minWidth: 'auto', px: { xs: 1, sm: 2 } }}
            >
              <CreateNewFolderIcon sx={{ mr: { xs: 0, sm: 1 } }} />
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                New Folder
              </Box>
            </Button>
          </Tooltip>
          <Tooltip title="Upload">
            <Button
              variant="contained"
              onClick={onUploadClick}
              sx={{ minWidth: 'auto', px: { xs: 1, sm: 2 } }}
            >
              <CloudUploadIcon sx={{ mr: { xs: 0, sm: 1 } }} />
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                Upload
              </Box>
            </Button>
          </Tooltip>
          <Tooltip title="Manage Connections">
            <Button
              variant="outlined"
              onClick={handleManageConnections}
              sx={{ minWidth: 'auto', px: { xs: 1, sm: 2 } }}
            >
              <SettingsIcon sx={{ mr: { xs: 0, sm: 1 } }} />
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                Manage Connections
              </Box>
            </Button>
          </Tooltip>
          <Tooltip title="Sign Out">
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
