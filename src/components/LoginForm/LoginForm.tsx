import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
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
import { buildBrowseUrl } from '../../utils/urlEncoding';
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

function isValidConnectionName(value: string): boolean {
  if (!value) return true; // Empty is valid (optional field)
  return !value.includes(' ');
}

export function LoginForm() {
  const navigate = useNavigate();
  const { connect, error } = useS3Client();
  const { connections, saveConnection, deleteConnection } = useConnectionHistory();
  const [isLoading, setIsLoading] = useState(false);
  const [autoDetectRegion, setAutoDetectRegion] = useState(true);
  const [endpointTouched, setEndpointTouched] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [selectedConnectionName, setSelectedConnectionName] = useState<string | null>(null);
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
      const credentials: LoginCredentials = {
        accessKeyId: formData.accessKeyId,
        secretAccessKey: formData.secretAccessKey,
        bucket: formData.bucket || undefined,
        region: autoDetectRegion ? undefined : formData.region || undefined,
        endpoint: formData.endpoint || undefined,
      };
      const success = await connect(credentials);

      if (success && formData.connectionName.trim() && nameValid) {
        // Only save connection on successful connect with valid name
        saveConnection({
          name: formData.connectionName.trim(),
          endpoint: formData.endpoint,
          accessKeyId: formData.accessKeyId,
          bucket: formData.bucket || undefined,
          region: autoDetectRegion ? undefined : formData.region || undefined,
          autoDetectRegion,
        });
      }
      // Reset touch states on successful form submission
      if (success) {
        setEndpointTouched(false);
        setNameTouched(false);

        // If bucket was provided, redirect to browse page
        if (formData.bucket) {
          void navigate(buildBrowseUrl(formData.bucket, ''), { replace: true });
        }
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
    const name = e.target.value;
    if (name === 'new') {
      setSelectedConnectionName(null);
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

    const connection = connections.find((c) => c.name === name);
    if (connection) {
      setSelectedConnectionName(connection.name);
      setFormData({
        connectionName: connection.name,
        endpoint: connection.endpoint,
        accessKeyId: connection.accessKeyId,
        bucket: connection.bucket || '',
        region: connection.region || '',
        secretAccessKey: '', // Never auto-fill secret
      });
      setAutoDetectRegion(connection.autoDetectRegion);
      setEndpointTouched(false);
      setNameTouched(false);
    }
  };

  const handleDeleteConnection = (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    e.preventDefault();
    deleteConnection(name);
    if (selectedConnectionName === name) {
      setSelectedConnectionName(null);
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

  // Bucket is now optional - if not provided, user will select from list
  const isFormValid =
    (autoDetectRegion || formData.bucket || formData.region) &&
    formData.accessKeyId &&
    formData.secretAccessKey &&
    endpointValid &&
    nameValid;

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
              value={selectedConnectionName || 'new'}
              label="Connection"
              onChange={handleConnectionChange}
              renderValue={(value) => {
                if (value === 'new') return 'New Connection';
                const conn = connections.find((c) => c.name === value);
                return conn?.name || 'New Connection';
              }}
            >
              <MenuItem value="new">New Connection</MenuItem>
              {connections.map((connection) => (
                <MenuItem key={connection.name} value={connection.name}>
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
                      onClick={(e) => handleDeleteConnection(e, connection.name)}
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
              error={showNameError}
              helperText={
                showNameError
                  ? 'Connection name cannot contain spaces'
                  : 'Optional. Provide a name (no spaces) to save this connection.'
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
              required
              autoComplete="off"
              helperText={selectedConnectionName ? 'Enter your secret key (not saved for security)' : undefined}
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
