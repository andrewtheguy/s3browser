import { useState, useEffect, type FormEvent } from 'react';
import {
  Box,
  Card,
  CardContent,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  List,
  ListItemButton,
  ListItemText,
  Divider,
  IconButton,
} from '@mui/material';
import CloudIcon from '@mui/icons-material/Cloud';
import LogoutIcon from '@mui/icons-material/Logout';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useS3Client } from '../../hooks';
import { listBuckets } from '../../services/api';
import type { BucketInfo } from '../../types';

export function BucketSelector() {
  const { selectBucket, disconnect, error: contextError } = useS3Client();
  const [buckets, setBuckets] = useState<BucketInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSelecting, setIsSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualBucket, setManualBucket] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);

  const fetchBuckets = async () => {
    setIsLoading(true);
    setError(null);
    setAccessDenied(false);

    try {
      const bucketList = await listBuckets();
      setBuckets(bucketList);
      if (bucketList.length === 0) {
        setShowManualInput(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list buckets';
      if (message.includes('Access denied') || message.includes('403')) {
        setAccessDenied(true);
        setShowManualInput(true);
      } else {
        setError(message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchBuckets();
  }, []);

  const handleSelectBucket = async (bucketName: string) => {
    setIsSelecting(true);
    setError(null);

    try {
      const success = await selectBucket(bucketName);
      if (!success) {
        setError('Failed to select bucket');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to select bucket';
      setError(message);
    } finally {
      setIsSelecting(false);
    }
  };

  const handleManualSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!manualBucket.trim()) return;
    await handleSelectBucket(manualBucket.trim());
  };

  const displayError = error || contextError;

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
      <Card sx={{ maxWidth: 500, width: '100%' }}>
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
              Select Bucket
            </Typography>
          </Box>

          <Typography
            variant="body2"
            color="text.secondary"
            textAlign="center"
            mb={3}
          >
            Choose a bucket to browse or enter one manually
          </Typography>

          {displayError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {displayError}
            </Alert>
          )}

          {accessDenied && (
            <Alert severity="info" sx={{ mb: 2 }}>
              You do not have permission to list buckets. Please enter a bucket name manually.
            </Alert>
          )}

          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : (
            <>
              {!showManualInput && buckets.length > 0 && (
                <>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="subtitle2" color="text.secondary">
                      Available Buckets ({buckets.length})
                    </Typography>
                    <IconButton size="small" onClick={fetchBuckets} disabled={isSelecting}>
                      <RefreshIcon fontSize="small" />
                    </IconButton>
                  </Box>
                  <List
                    sx={{
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                      maxHeight: 300,
                      overflow: 'auto',
                      mb: 2,
                    }}
                  >
                    {buckets.map((bucket, index) => (
                      <Box key={bucket.name}>
                        <ListItemButton
                          onClick={() => handleSelectBucket(bucket.name)}
                          disabled={isSelecting}
                        >
                          <ListItemText
                            primary={bucket.name}
                            secondary={bucket.creationDate ? `Created: ${new Date(bucket.creationDate).toLocaleDateString()}` : undefined}
                          />
                        </ListItemButton>
                        {index < buckets.length - 1 && <Divider />}
                      </Box>
                    ))}
                  </List>
                  <Button
                    variant="text"
                    onClick={() => setShowManualInput(true)}
                    sx={{ mb: 2 }}
                    disabled={isSelecting}
                  >
                    Enter bucket name manually
                  </Button>
                </>
              )}

              {(showManualInput || buckets.length === 0) && (
                <Box component="form" onSubmit={handleManualSubmit}>
                  {buckets.length > 0 && (
                    <Button
                      variant="text"
                      onClick={() => setShowManualInput(false)}
                      sx={{ mb: 2 }}
                      disabled={isSelecting}
                    >
                      Back to bucket list
                    </Button>
                  )}
                  <TextField
                    fullWidth
                    label="Bucket Name"
                    value={manualBucket}
                    onChange={(e) => setManualBucket(e.target.value)}
                    margin="normal"
                    required
                    autoComplete="off"
                    placeholder="my-bucket-name"
                    disabled={isSelecting}
                  />
                  <Button
                    type="submit"
                    fullWidth
                    variant="contained"
                    size="large"
                    disabled={!manualBucket.trim() || isSelecting}
                    sx={{ mt: 2 }}
                  >
                    {isSelecting ? (
                      <CircularProgress size={24} color="inherit" />
                    ) : (
                      'Connect to Bucket'
                    )}
                  </Button>
                </Box>
              )}

              {isSelecting && !showManualInput && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                  <CircularProgress size={24} />
                </Box>
              )}
            </>
          )}

          <Divider sx={{ my: 3 }} />

          <Button
            fullWidth
            variant="outlined"
            color="inherit"
            startIcon={<LogoutIcon />}
            onClick={disconnect}
            disabled={isSelecting}
          >
            Disconnect
          </Button>
        </CardContent>
      </Card>
    </Box>
  );
}
