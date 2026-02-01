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
} from '@mui/material';
import CloudIcon from '@mui/icons-material/Cloud';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useS3Client } from '../../hooks';
import { S3ConnectionForm } from '../S3ConnectionForm';

function PasswordLoginForm({
  error: contextError,
  isLoading,
  setIsLoading,
}: {
  error: string | null;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}) {
  const { login } = useS3Client();
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError || contextError;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setLocalError(null);

    try {
      await login({ password });
      // isLoggedIn will be updated in context on success
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      console.error('Login error:', err);
      setLocalError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const isFormValid = password.length > 0;

  return (
    <Box component="form" onSubmit={handleSubmit}>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TextField
        fullWidth
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        margin="normal"
        required
        autoComplete="current-password"
        autoFocus
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

export function LoginForm() {
  const { isLoggedIn, error: contextError, serverError, disconnect, retryConnection, isCheckingSession } = useS3Client();
  const [isLoading, setIsLoading] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const error = logoutError || contextError;

  const handleLogout = async () => {
    setLogoutError(null);
    try {
      await disconnect();
    } catch (err) {
      console.error('Logout failed:', err);
      const message = err instanceof Error ? err.message : 'Logout failed';
      setLogoutError(message);
    }
  };

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

          {isCheckingSession && !serverError ? (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                py: 4,
              }}
            >
              <CircularProgress size={40} sx={{ mb: 2 }} />
              <Typography variant="body2" color="text.secondary">
                Connecting to server...
              </Typography>
            </Box>
          ) : serverError ? (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
              }}
            >
              <ErrorOutlineIcon sx={{ fontSize: 48, color: 'error.main', mb: 2 }} />
              <Typography variant="h6" color="error" gutterBottom>
                Server Connection Error
              </Typography>
              <Typography variant="body2" color="text.secondary" mb={3}>
                {serverError}
              </Typography>
              <Button
                variant="contained"
                startIcon={isCheckingSession ? <CircularProgress size={20} color="inherit" /> : <RefreshIcon />}
                onClick={retryConnection}
                disabled={isCheckingSession}
              >
                {isCheckingSession ? 'Connecting...' : 'Retry Connection'}
              </Button>
            </Box>
          ) : !isLoggedIn ? (
            <>
              <Typography
                variant="body2"
                color="text.secondary"
                textAlign="center"
                mb={3}
              >
                Enter password to continue
              </Typography>

              <PasswordLoginForm
                error={error}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
              />
            </>
          ) : (
            <>
              <S3ConnectionForm
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
