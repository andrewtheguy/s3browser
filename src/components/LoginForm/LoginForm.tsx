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
