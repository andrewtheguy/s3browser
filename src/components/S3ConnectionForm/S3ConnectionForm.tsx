import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  Box,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  FormControlLabel,
  Checkbox,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  ListItemText,
  Divider,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import LogoutIcon from '@mui/icons-material/Logout';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useS3Client, useConnectionHistory } from '../../hooks';
import { buildBrowseUrl, buildSelectBucketUrl } from '../../utils/urlEncoding';
import type { S3ConnectionCredentials } from '../../types';

function isValidUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidConnectionName(value: string): boolean {
  if (!value) return false;
  // Allow only letters, numbers, dashes, underscores, and dots
  // Enforce length between 1 and 64 characters
  if (value.length > 64) return false;
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

interface S3ConnectionFormProps {
  error: string | null;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  onLogout: () => void;
}

export function S3ConnectionForm({
  error,
  isLoading,
  setIsLoading,
  onLogout,
}: S3ConnectionFormProps) {
  const navigate = useNavigate();
  const { connect, isLoggedIn, activeConnectionId, credentials: activeCredentials, isConnected } = useS3Client();
  const { connections, deleteConnection, isLoading: connectionsLoading } = useConnectionHistory(isLoggedIn);

  // Check if we can continue browsing (have an active connection)
  const canContinueBrowsing = isConnected && activeConnectionId;
  const [autoDetectRegion, setAutoDetectRegion] = useState(true);
  const [endpointTouched, setEndpointTouched] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<number | null>(null);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    connectionName: '',
    region: '',
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
    endpoint: 'https://s3.amazonaws.com',
  });

  const endpointValid = isValidUrl(formData.endpoint);
  const showEndpointError = endpointTouched && !endpointValid;
  const nameValid = isValidConnectionName(formData.connectionName);
  const showNameError = nameTouched && !nameValid;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const credentials: S3ConnectionCredentials = {
        accessKeyId: formData.accessKeyId,
        secretAccessKey: formData.secretAccessKey,
        bucket: formData.bucket || undefined,
        region: autoDetectRegion ? undefined : formData.region || undefined,
        endpoint: formData.endpoint || undefined,
        connectionName: formData.connectionName.trim(),
        autoDetectRegion,
        connectionId: selectedConnectionId ?? undefined,
      };
      const result = await connect(credentials);

      if (!result.success || !result.connectionId) {
        return;
      }

      setEndpointTouched(false);
      setNameTouched(false);

      if (formData.bucket) {
        void navigate(buildBrowseUrl(result.connectionId, formData.bucket, ''), { replace: true });
      } else {
        void navigate(buildSelectBucketUrl(result.connectionId), { replace: true });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (field: keyof typeof formData) => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setFormData((prev) => ({ ...prev, [field]: e.target.value }));
  };

  const handleConnectionChange = (e: SelectChangeEvent<string>) => {
    const value = e.target.value;
    if (value === 'new') {
      setSelectedConnectionId(null);
      setFormData({
        connectionName: '',
        endpoint: 'https://s3.amazonaws.com',
        accessKeyId: '',
        bucket: '',
        region: '',
        secretAccessKey: '',
      });
      setAutoDetectRegion(true);
      setEndpointTouched(false);
      setNameTouched(false);
      return;
    }

    const id = parseInt(value, 10);
    const connection = connections.find((c) => c.id === id);
    if (connection) {
      setSelectedConnectionId(connection.id);
      setFormData({
        connectionName: connection.name,
        endpoint: connection.endpoint,
        accessKeyId: connection.accessKeyId,
        bucket: connection.bucket || '',
        region: connection.region || '',
        secretAccessKey: '', // Secret key must be re-entered for security
      });
      setAutoDetectRegion(connection.autoDetectRegion);
      setEndpointTouched(false);
      setNameTouched(false);
    }
  };

  const handleDeleteConnection = async (e: React.MouseEvent, connectionId: number, name: string) => {
    e.stopPropagation();
    e.preventDefault();
    setDeletionError(null);
    try {
      await deleteConnection(connectionId);
      if (selectedConnectionId === connectionId) {
        setSelectedConnectionId(null);
        setFormData({
          connectionName: '',
          endpoint: 'https://s3.amazonaws.com',
          accessKeyId: '',
          bucket: '',
          region: '',
          secretAccessKey: '',
        });
        setAutoDetectRegion(true);
      }
    } catch (err) {
      console.error('Failed to delete connection:', err);
      const message = err instanceof Error ? err.message : 'Failed to delete connection';
      setDeletionError(`Could not delete "${name}": ${message}`);
    }
  };

  // Secret key is optional when using an existing saved connection
  const isExistingConnection = selectedConnectionId !== null;
  const isFormValid =
    (autoDetectRegion || formData.bucket || formData.region) &&
    formData.connectionName.trim() &&
    formData.accessKeyId &&
    (isExistingConnection || formData.secretAccessKey) &&
    endpointValid &&
    nameValid;

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', mb: 2 }}>
        <Button
          size="small"
          startIcon={<LogoutIcon />}
          onClick={onLogout}
        >
          Sign Out
        </Button>
      </Box>

      <Divider sx={{ mb: 2 }} />

      {deletionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setDeletionError(null)}>
          {deletionError}
        </Alert>
      )}

      {canContinueBrowsing && (
        <Button
          fullWidth
          variant="outlined"
          color="primary"
          startIcon={<ArrowForwardIcon />}
          onClick={() => {
            if (activeCredentials?.bucket) {
              void navigate(buildBrowseUrl(activeConnectionId, activeCredentials.bucket, ''));
            } else {
              void navigate(buildSelectBucketUrl(activeConnectionId));
            }
          }}
          sx={{ mb: 2 }}
        >
          Continue Browsing{activeCredentials?.bucket ? ` (${activeCredentials.bucket})` : ''}
        </Button>
      )}

      <Typography variant="body2" color="text.secondary" textAlign="center" mb={2}>
        {canContinueBrowsing ? 'Or connect to a different S3 storage' : 'Enter your S3 credentials to browse storage'}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <FormControl fullWidth sx={{ mb: 2 }}>
        <InputLabel id="connection-select-label">Saved Connection</InputLabel>
        <Select
          labelId="connection-select-label"
          value={selectedConnectionId !== null ? String(selectedConnectionId) : 'new'}
          label="Saved Connection"
          onChange={handleConnectionChange}
          disabled={connectionsLoading}
          renderValue={(value) => {
            if (value === 'new') return 'New Connection';
            const conn = connections.find((c) => c.id === parseInt(value, 10));
            return conn?.name || 'New Connection';
          }}
        >
          <MenuItem value="new">New Connection</MenuItem>
          {connections.map((connection) => (
            <MenuItem key={connection.id} value={String(connection.id)}>
              <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}>
                <ListItemText
                  primary={connection.name}
                  secondary={connection.bucket ? `${connection.bucket} @ ${connection.endpoint}` : connection.endpoint}
                  primaryTypographyProps={{ noWrap: true }}
                  secondaryTypographyProps={{ noWrap: true, fontSize: '0.75rem' }}
                  sx={{ flex: 1, minWidth: 0, mr: 1 }}
                />
                <IconButton
                  size="small"
                  onClick={(e) => handleDeleteConnection(e, connection.id, connection.name)}
                  aria-label="delete"
                  sx={{ flexShrink: 0 }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Box component="form" onSubmit={handleSubmit}>
        <TextField
          fullWidth
          label="Connection Name"
          value={formData.connectionName}
          onChange={handleChange('connectionName')}
          onBlur={() => setNameTouched(true)}
          margin="normal"
          autoComplete="off"
          placeholder="my-aws-account"
          required
          error={showNameError}
          helperText={
            showNameError
              ? 'Connection name cannot contain spaces'
              : 'A unique name for this connection (no spaces).'
          }
        />

        <TextField
          fullWidth
          label="Endpoint URL"
          value={formData.endpoint}
          onChange={handleChange('endpoint')}
          onBlur={() => setEndpointTouched(true)}
          margin="normal"
          autoComplete="off"
          error={showEndpointError}
          helperText={
            showEndpointError
              ? 'Please enter a valid URL (e.g., https://s3.amazonaws.com)'
              : 'Default is AWS S3. Change for S3-compatible services (MinIO, etc.)'
          }
        />

        <TextField
          fullWidth
          label="Access Key ID"
          value={formData.accessKeyId}
          onChange={handleChange('accessKeyId')}
          margin="normal"
          required
          autoComplete="off"
        />

        <TextField
          fullWidth
          label="Secret Access Key"
          type="password"
          value={formData.secretAccessKey}
          onChange={handleChange('secretAccessKey')}
          margin="normal"
          required={!isExistingConnection}
          autoComplete="off"
          placeholder={isExistingConnection ? 'Leave empty to keep existing' : undefined}
          helperText={isExistingConnection ? 'Leave empty to use saved key, or enter new key to update' : undefined}
        />

        <TextField
          fullWidth
          label="Bucket Name"
          value={formData.bucket}
          onChange={handleChange('bucket')}
          margin="normal"
          autoComplete="off"
          helperText="Leave empty to list available buckets after login"
        />

        <FormControlLabel
          control={
            <Checkbox
              checked={autoDetectRegion}
              onChange={(e) => setAutoDetectRegion(e.target.checked)}
            />
          }
          label="Auto-detect region from bucket"
          sx={{ mt: 1 }}
        />

        {!autoDetectRegion && (
          <TextField
            fullWidth
            label="Region"
            value={formData.region}
            onChange={handleChange('region')}
            margin="normal"
            required
            autoComplete="off"
            placeholder="us-east-1"
          />
        )}

        <Button
          type="submit"
          fullWidth
          variant="contained"
          size="large"
          disabled={!isFormValid || isLoading}
          sx={{ mt: 3 }}
        >
          {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Connect'}
        </Button>
      </Box>
    </>
  );
}
