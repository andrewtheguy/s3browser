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
  Collapse,
  IconButton,
} from '@mui/material';
import CloudIcon from '@mui/icons-material/Cloud';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useS3Client } from '../../hooks';
import { AWS_REGIONS, type LoginCredentials } from '../../types';

const AUTO_DETECT_VALUE = '__auto__';

export function LoginForm() {
  const { connect, error } = useS3Client();
  const [isLoading, setIsLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [formData, setFormData] = useState({
    region: AUTO_DETECT_VALUE,
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
    endpoint: '',
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const credentials: LoginCredentials = {
        accessKeyId: formData.accessKeyId,
        secretAccessKey: formData.secretAccessKey,
        bucket: formData.bucket,
        region: formData.region === AUTO_DETECT_VALUE ? undefined : formData.region,
        endpoint: formData.endpoint || undefined,
      };
      await connect(credentials);
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
            Connect to AWS S3 or S3-compatible storage
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
              <MenuItem value={AUTO_DETECT_VALUE}>
                Auto-detect from bucket
              </MenuItem>
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

            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                mt: 1,
                cursor: 'pointer',
              }}
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              <Typography variant="body2" color="text.secondary">
                Advanced options
              </Typography>
              <IconButton size="small">
                {showAdvanced ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              </IconButton>
            </Box>

            <Collapse in={showAdvanced}>
              <TextField
                fullWidth
                label="Custom Endpoint (optional)"
                value={formData.endpoint}
                onChange={handleChange('endpoint')}
                margin="normal"
                autoComplete="off"
                placeholder="https://s3.example.com"
                helperText="For S3-compatible services (MinIO, DigitalOcean Spaces, etc.)"
              />
            </Collapse>

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
