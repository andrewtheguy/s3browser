import { useState, type FormEvent } from 'react';
import {
  Box,
  Card,
  CardContent,
  TextField,
  Button,
  Typography,
  Alert,
  MenuItem,
  CircularProgress,
} from '@mui/material';
import CloudIcon from '@mui/icons-material/Cloud';
import { useS3Client } from '../../hooks';
import { AWS_REGIONS, type S3Credentials } from '../../types';

export function LoginForm() {
  const { connect, error } = useS3Client();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState<S3Credentials>({
    region: 'us-east-1',
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await connect(formData);
    } catch {
      // Error is handled by context
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (field: keyof S3Credentials) => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setFormData((prev) => ({ ...prev, [field]: e.target.value }));
  };

  const isFormValid =
    formData.region &&
    formData.accessKeyId &&
    formData.secretAccessKey &&
    formData.bucket;

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
            Enter your AWS credentials to connect to your S3 bucket
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          <Box component="form" onSubmit={handleSubmit}>
            <TextField
              select
              fullWidth
              label="AWS Region"
              value={formData.region}
              onChange={handleChange('region')}
              margin="normal"
              required
            >
              {AWS_REGIONS.map((region) => (
                <MenuItem key={region.value} value={region.value}>
                  {region.label}
                </MenuItem>
              ))}
            </TextField>

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
              required
              autoComplete="off"
            />

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
            Your credentials are stored in session storage and cleared when you
            close the browser.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
