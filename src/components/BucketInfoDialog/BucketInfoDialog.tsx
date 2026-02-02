import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  IconButton,
  CircularProgress,
  Box,
  Typography,
  Table,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useParams } from 'react-router';
import { useS3ClientContext } from '../../contexts';
import { getBucketInfo, type BucketInfo, type LifecycleRule } from '../../services/api/bucket';

interface BucketInfoDialogProps {
  open: boolean;
  onClose: () => void;
}

function LifecycleRuleDetails({ rule }: { rule: LifecycleRule }) {
  const details: string[] = [];

  if (rule.prefix) {
    details.push(`Prefix: ${rule.prefix}`);
  }

  if (rule.expiration) {
    if (rule.expiration.days) {
      details.push(`Expires after ${rule.expiration.days} days`);
    }
    if (rule.expiration.date) {
      details.push(`Expires on ${new Date(rule.expiration.date).toLocaleDateString()}`);
    }
    if (rule.expiration.expiredObjectDeleteMarker) {
      details.push('Delete expired object markers');
    }
  }

  if (rule.transitions) {
    for (const t of rule.transitions) {
      if (t.days) {
        details.push(`Transition to ${t.storageClass} after ${t.days} days`);
      } else if (t.date) {
        details.push(`Transition to ${t.storageClass} on ${new Date(t.date).toLocaleDateString()}`);
      }
    }
  }

  if (rule.noncurrentVersionExpiration) {
    if (rule.noncurrentVersionExpiration.days) {
      details.push(`Delete noncurrent versions after ${rule.noncurrentVersionExpiration.days} days`);
    }
    if (rule.noncurrentVersionExpiration.newerNoncurrentVersions) {
      details.push(`Keep ${rule.noncurrentVersionExpiration.newerNoncurrentVersions} newer noncurrent versions`);
    }
  }

  if (rule.abortIncompleteMultipartUpload?.daysAfterInitiation) {
    details.push(`Abort incomplete multipart uploads after ${rule.abortIncompleteMultipartUpload.daysAfterInitiation} days`);
  }

  return (
    <Box sx={{ pl: 2 }}>
      {details.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {details.map((detail, i) => (
            <li key={i}>
              <Typography variant="body2" color="text.secondary">
                {detail}
              </Typography>
            </li>
          ))}
        </ul>
      ) : (
        <Typography variant="body2" color="text.secondary">
          No actions configured
        </Typography>
      )}
    </Box>
  );
}

export function BucketInfoDialog({ open, onClose }: BucketInfoDialogProps) {
  const { activeConnectionId, credentials } = useS3ClientContext();
  const { bucket: urlBucket } = useParams<{ bucket: string }>();
  const bucket = urlBucket || credentials?.bucket;

  const [info, setInfo] = useState<BucketInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !activeConnectionId || !bucket) {
      setInfo(null);
      setError(null);
      return;
    }

    const abortController = new AbortController();
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const data = await getBucketInfo(
          activeConnectionId,
          bucket,
          abortController.signal
        );
        if (!abortController.signal.aborted) {
          setInfo(data);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load bucket info');
        }
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [open, activeConnectionId, bucket]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Bucket Settings
        <IconButton onClick={onClose} size="small" aria-label="close">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {isLoading ? (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={32} />
          </Box>
        ) : error ? (
          <Typography color="error">{error}</Typography>
        ) : info ? (
          <Box>
            <Table size="small">
              <TableBody>
                <TableRow>
                  <TableCell component="th" sx={{ fontWeight: 500, width: 140 }}>
                    Bucket
                  </TableCell>
                  <TableCell>{bucket}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell component="th" sx={{ fontWeight: 500 }}>
                    Versioning
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={info.versioning.status}
                      size="small"
                      color={info.versioning.status === 'Enabled' ? 'success' : 'default'}
                      variant="outlined"
                    />
                    {info.versioning.mfaDelete === 'Enabled' && (
                      <Chip
                        label="MFA Delete"
                        size="small"
                        color="warning"
                        variant="outlined"
                        sx={{ ml: 1 }}
                      />
                    )}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell component="th" sx={{ fontWeight: 500 }}>
                    Default Encryption
                  </TableCell>
                  <TableCell>
                    {info.encryption?.enabled ? (
                      <Box>
                        <Chip
                          label={info.encryption.type}
                          size="small"
                          color="success"
                          variant="outlined"
                        />
                        {info.encryption.kmsKeyId && (
                          <Typography
                            variant="caption"
                            display="block"
                            color="text.secondary"
                            sx={{ mt: 0.5, wordBreak: 'break-all' }}
                          >
                            Key: {info.encryption.kmsKeyId}
                          </Typography>
                        )}
                      </Box>
                    ) : (
                      <Chip label="None" size="small" variant="outlined" />
                    )}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
              Lifecycle Rules ({info.lifecycleRules.length})
            </Typography>
            {info.lifecycleRules.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No lifecycle rules configured
              </Typography>
            ) : (
              info.lifecycleRules.map((rule, index) => (
                <Accordion key={rule.id || index} disableGutters>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="body2">
                        {rule.id || `Rule ${index + 1}`}
                      </Typography>
                      <Chip
                        label={rule.status}
                        size="small"
                        color={rule.status === 'Enabled' ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </Box>
                  </AccordionSummary>
                  <AccordionDetails>
                    <LifecycleRuleDetails rule={rule} />
                  </AccordionDetails>
                </Accordion>
              ))
            )}
          </Box>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
