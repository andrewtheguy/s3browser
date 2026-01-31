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
  Divider,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import CloudIcon from '@mui/icons-material/Cloud';
import DeleteIcon from '@mui/icons-material/Delete';
import LogoutIcon from '@mui/icons-material/Logout';
import { useS3Client, useConnectionHistory } from '../../hooks';
import { buildBrowseUrl } from '../../utils/urlEncoding';
import type { LoginCredentials } from '../../types';

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
  if (!value) return true;
  return !value.includes(' ');
}

function UserLoginForm({
  onSuccess,
  error,
  isLoading,
  setIsLoading,
}: {
  onSuccess: () => void;
  error: string | null;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}) {
  const { userLogin } = useS3Client();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const success = await userLogin({ username, password });
      if (success) {
        onSuccess();
      }
    } finally {
      setIsLoading(false);
    }
  };

  const isFormValid = username.trim().length > 0 && password.length > 0;

  return (
    <Box component="form" onSubmit={handleSubmit}>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TextField
        fullWidth
        label="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        margin="normal"
        required
        autoComplete="username"
        autoFocus
      />

      <TextField
        fullWidth
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        margin="normal"
        required
        autoComplete="current-password"
      />

      <Button
        type="submit"
        fullWidth
        variant="contained"
        size="large"
        disabled={!isFormValid || isLoading}
        sx={{ mt: 3 }}
      >
        {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Sign In'}
      </Button>
    </Box>
  );
}

function S3CredentialsForm({
  username,
  error,
  isLoading,
  setIsLoading,
  onLogout,
}: {
  username: string;
  error: string | null;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const { connect, isUserLoggedIn } = useS3Client();
  const { connections, saveConnection, deleteConnection, isLoading: connectionsLoading } = useConnectionHistory(isUserLoggedIn);
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
        try {
          await saveConnection({
            name: formData.connectionName.trim(),
            endpoint: formData.endpoint,
            accessKeyId: formData.accessKeyId,
            secretAccessKey: formData.secretAccessKey,
            bucket: formData.bucket || undefined,
            region: autoDetectRegion ? undefined : formData.region || undefined,
            autoDetectRegion,
          });
        } catch (err) {
          console.error('Failed to save connection:', err);
        }
      }

      if (success) {
        setEndpointTouched(false);
        setNameTouched(false);

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
        secretAccessKey: connection.secretAccessKey,
      });
      setAutoDetectRegion(connection.autoDetectRegion);
      setEndpointTouched(false);
      setNameTouched(false);
    }
  };

  const handleDeleteConnection = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await deleteConnection(name);
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
    } catch (err) {
      console.error('Failed to delete connection:', err);
    }
  };

  const isFormValid =
    (autoDetectRegion || formData.bucket || formData.region) &&
    formData.accessKeyId &&
    formData.secretAccessKey &&
    endpointValid &&
    nameValid;

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Signed in as <strong>{username}</strong>
        </Typography>
        <Button
          size="small"
          startIcon={<LogoutIcon />}
          onClick={onLogout}
          sx={{ ml: 1 }}
        >
          Sign Out
        </Button>
      </Box>

      <Divider sx={{ mb: 2 }} />

      <Typography variant="body2" color="text.secondary" textAlign="center" mb={2}>
        Enter your S3 credentials to browse storage
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
          value={selectedConnectionName || 'new'}
          label="Saved Connection"
          onChange={handleConnectionChange}
          disabled={connectionsLoading}
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

export function LoginForm() {
  const { isUserLoggedIn, username, error, disconnect } = useS3Client();
  const [isLoading, setIsLoading] = useState(false);
  const [justLoggedIn, setJustLoggedIn] = useState(false);

  const handleUserLoginSuccess = () => {
    setJustLoggedIn(true);
  };

  const handleLogout = async () => {
    await disconnect();
    setJustLoggedIn(false);
  };

  const showS3Form = isUserLoggedIn || justLoggedIn;

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

          {!showS3Form ? (
            <>
              <Typography
                variant="body2"
                color="text.secondary"
                textAlign="center"
                mb={3}
              >
                Sign in to continue
              </Typography>

              <UserLoginForm
                onSuccess={handleUserLoginSuccess}
                error={error}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
              />

              <Typography
                variant="caption"
                color="text.secondary"
                display="block"
                textAlign="center"
                mt={3}
              >
                Use <code>bun run register -u username</code> to create an account
              </Typography>
            </>
          ) : (
            <>
              <S3CredentialsForm
                username={username || ''}
                error={error}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
                onLogout={handleLogout}
              />

              <Typography
                variant="caption"
                color="text.secondary"
                display="block"
                textAlign="center"
                mt={3}
              >
                S3 credentials are encrypted and stored securely. Session expires after 4 hours.
              </Typography>
            </>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
