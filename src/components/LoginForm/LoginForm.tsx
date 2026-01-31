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
import { useS3Client } from '../../hooks';
import { S3ConnectionForm } from '../S3ConnectionForm';

function UserLoginForm({
  error: contextError,
  isLoading,
  setIsLoading,
}: {
  error: string | null;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}) {
  const { userLogin } = useS3Client();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError || contextError;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setLocalError(null);

    try {
      await userLogin({ username, password });
      // isUserLoggedIn will be updated in context on success
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      console.error('Login error:', err);
      setLocalError(message);
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

export function LoginForm() {
  const { isUserLoggedIn, username, error: contextError, disconnect } = useS3Client();
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

          {!isUserLoggedIn ? (
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
              <S3ConnectionForm
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
