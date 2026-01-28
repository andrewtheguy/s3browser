import { useState, type FormEvent } from 'react';
import {
  Box,
  Card,
  CardContent,
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
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import CloudIcon from '@mui/icons-material/Cloud';
import DeleteIcon from '@mui/icons-material/Delete';
import { useS3Client, useConnectionHistory } from '../../hooks';
import type { LoginCredentials } from '../../types';

function isValidUrl(value: string): boolean {
  if (!value) return true; // Empty is valid (optional field)
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function LoginForm() {
  const { connect, error } = useS3Client();
  const { connections, saveConnection, deleteConnection, updateLastUsed } = useConnectionHistory();
  const [isLoading, setIsLoading] = useState(false);
  const [autoDetectRegion, setAutoDetectRegion] = useState(true);
  const [endpointTouched, setEndpointTouched] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const credentials: LoginCredentials = {
        accessKeyId: formData.accessKeyId,
        secretAccessKey: formData.secretAccessKey,
        bucket: formData.bucket,
        region: autoDetectRegion ? undefined : formData.region || undefined,
        endpoint: formData.endpoint || undefined,
      };
      await connect(credentials);

      // On successful connect, save/update connection if name provided
      if (formData.connectionName.trim()) {
        saveConnection({
          id: selectedConnectionId || undefined,
          name: formData.connectionName.trim(),
          endpoint: formData.endpoint,
          accessKeyId: formData.accessKeyId,
          bucket: formData.bucket,
          region: autoDetectRegion ? undefined : formData.region || undefined,
          autoDetectRegion,
        });
      } else if (selectedConnectionId) {
        // Update lastUsedAt even if no name change
        updateLastUsed(selectedConnectionId);
      }
    } catch {
      // Error is handled by context
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
    const id = e.target.value;
    if (id === 'new') {
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
      return;
    }

    const connection = connections.find((c) => c.id === id);
    if (connection) {
      setSelectedConnectionId(connection.id);
      setFormData({
        connectionName: connection.name,
        endpoint: connection.endpoint,
        accessKeyId: connection.accessKeyId,
        bucket: connection.bucket,
        region: connection.region || '',
        secretAccessKey: '', // Never auto-fill secret
      });
      setAutoDetectRegion(connection.autoDetectRegion);
    }
  };

  const handleDeleteConnection = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    deleteConnection(id);
    if (selectedConnectionId === id) {
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
  };

  const isFormValid =
    (autoDetectRegion || formData.region) &&
    formData.accessKeyId &&
    formData.secretAccessKey &&
    formData.bucket &&
    endpointValid;

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Card sx={{ maxWidth: 450, width: '100%' }}>
        <CardContent sx={{ p: 4 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              mb: 3,
            }}
          >
            <CloudIcon sx={{ fontSize: 40, color: 'primary.main', mr: 1 }} />
            <Typography variant="h5" component="h1" fontWeight="bold">
              S3 Browser
            </Typography>
          </Box>

          <Typography
            variant="body2"
            color="text.secondary"
            textAlign="center"
            mb={3}
          >
            Connect to AWS S3 or S3-compatible storage
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel id="connection-select-label">Connection</InputLabel>
            <Select
              labelId="connection-select-label"
              value={selectedConnectionId || 'new'}
              label="Connection"
              onChange={handleConnectionChange}
              renderValue={(value) => {
                if (value === 'new') return 'New Connection';
                const conn = connections.find((c) => c.id === value);
                return conn?.name || 'New Connection';
              }}
            >
              <MenuItem value="new">New Connection</MenuItem>
              {connections.map((connection) => (
                <MenuItem key={connection.id} value={connection.id}>
                  <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}>
                    <ListItemText
                      primary={connection.name}
                      secondary={`${connection.bucket} @ ${connection.endpoint}`}
                      primaryTypographyProps={{ noWrap: true }}
                      secondaryTypographyProps={{ noWrap: true, fontSize: '0.75rem' }}
                      sx={{ flex: 1, minWidth: 0, mr: 1 }}
                    />
                    <IconButton
                      size="small"
                      onClick={(e) => handleDeleteConnection(e, connection.id)}
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
              margin="normal"
              autoComplete="off"
              placeholder="My AWS Account"
              helperText="Optional. Provide a name to save this connection for later."
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
              required
              autoComplete="off"
              helperText={selectedConnectionId ? 'Enter your secret key (not saved for security)' : undefined}
            />

            <TextField
              fullWidth
              label="Bucket Name"
              value={formData.bucket}
              onChange={handleChange('bucket')}
              margin="normal"
              required
              autoComplete="off"
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
              {isLoading ? (
                <CircularProgress size={24} color="inherit" />
              ) : (
                'Connect'
              )}
            </Button>
          </Box>

          <Typography
            variant="caption"
            color="text.secondary"
            display="block"
            textAlign="center"
            mt={3}
          >
            Your credentials are stored securely on the server and the session
            expires after 4 hours.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
