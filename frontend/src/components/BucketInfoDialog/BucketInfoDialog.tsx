import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { useBrowserContext } from '../../contexts';
import { useBucketRoute } from '../../hooks/useBucketRoute';
import { useConnectionQuery } from '../../queries/connections';
import { downloadTextFile } from '../../utils/download';
import { getBucketInfo, type BucketInfo, type LifecycleRule } from '../../services/api/bucket';
import { exportConnectionProfile } from '../../services/api/auth';

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
    <div className="pl-4">
      {details.length > 0 ? (
        <ul className="list-disc pl-4 space-y-1">
          {details.map((detail, i) => (
            <li key={i} className="text-sm text-muted-foreground">
              {detail}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No actions configured
        </p>
      )}
    </div>
  );
}

export function BucketInfoDialog({ open, onClose }: BucketInfoDialogProps) {
  const { connectionId: activeConnectionId, bucket } = useBucketRoute();
  const { data: connection } = useConnectionQuery(activeConnectionId);
  const { versioningSupported, bucketVersioningStatus } = useBrowserContext();

  const [info, setInfo] = useState<BucketInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<null | 'aws' | 'rclone'>(null);
  const isMountedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setInfo(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    const abortController = new AbortController();
    setIsLoading(true);
    setError(null);
    getBucketInfo(activeConnectionId, bucket, abortController.signal)
      .then((result) => {
        if (!abortController.signal.aborted) setInfo(result);
      })
      .catch((err: unknown) => {
        if (!abortController.signal.aborted) {
          setError(`Failed to load bucket info: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      })
      .finally(() => {
        if (!abortController.signal.aborted) setIsLoading(false);
      });
    return () => abortController.abort();
  }, [open, activeConnectionId, bucket]);

  const handleExportProfile = async (format: 'aws' | 'rclone') => {
    setExportingFormat(format);
    try {
      const response = await exportConnectionProfile(activeConnectionId, format, bucket);
      if (!isMountedRef.current) {
        return;
      }
      downloadTextFile(response.filename, response.content);
      toast.success(`${format === 'aws' ? 'AWS' : 'rclone'} profile exported`);
    } catch (err) {
      if (!isMountedRef.current) {
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to export profile';
      toast.error(message);
    } finally {
      if (isMountedRef.current) {
        setExportingFormat(null);
      }
    }
  };

  const showSeparator = isLoading || !!error || !!info;
  const exportBusy = exportingFormat !== null;
  const versionSupportState: { label: string; variant: 'default' | 'outline' | 'secondary' } =
    bucketVersioningStatus === 'disabled'
      ? { label: 'Disabled', variant: 'secondary' }
      : versioningSupported === null
        ? { label: 'Checking', variant: 'outline' }
        : versioningSupported === false
          ? { label: 'Not Supported', variant: 'secondary' }
          : { label: 'Supported', variant: 'default' };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bucket Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="lg" />
            </div>
          ) : error ? (
            <p className="text-destructive">{error}</p>
          ) : info ? (
            <>
              <Table>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium w-[140px]">
                      Profile
                    </TableCell>
                    <TableCell className="break-all">
                      {connection?.profileName ?? '—'}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium w-[140px]">
                      Endpoint
                    </TableCell>
                    <TableCell className="break-all">
                      {connection?.endpoint || 'AWS S3 (default)'}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium w-[140px]">
                      Bucket
                    </TableCell>
                    <TableCell>{bucket}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium w-[140px]">
                      Versioning
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={info.versioning?.status === 'Enabled' ? 'default' : 'secondary'}
                        >
                          {info.versioning?.status || 'Disabled'}
                        </Badge>
                        {info.versioning?.mfaDelete === 'Enabled' && (
                          <Badge variant="warning">
                            MFA Delete
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium w-[140px]">
                      Version Support
                    </TableCell>
                    <TableCell>
                      <Badge variant={versionSupportState.variant}>
                        {versionSupportState.label}
                      </Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">
                      Default Encryption
                    </TableCell>
                    <TableCell>
                      {info.encryptionError ? (
                        <div>
                          <Badge variant="warning">Unknown</Badge>
                          <p className="text-xs text-muted-foreground mt-1">
                            {info.encryptionError}
                          </p>
                        </div>
                      ) : info.encryption?.algorithm ? (
                        <div>
                          <Badge variant="default">
                            {info.encryption.algorithm}
                          </Badge>
                          {info.encryption.kmsKeyId && (
                            <p className="text-xs text-muted-foreground mt-1 break-all">
                              Key: {info.encryption.kmsKeyId}
                            </p>
                          )}
                        </div>
                      ) : (
                        <Badge variant="secondary">None</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>

              <div>
                <h3 className="text-sm font-medium mb-2">
                  Lifecycle Rules ({info.lifecycleRules.length})
                </h3>
                {info.lifecycleRules.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No lifecycle rules configured
                  </p>
                ) : (
                  <Accordion type="single" collapsible>
                    {info.lifecycleRules.map((rule, index) => (
                      <AccordionItem key={rule.id || index} value={rule.id || String(index)}>
                        <AccordionTrigger className="py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm">
                              {rule.id || `Rule ${index + 1}`}
                            </span>
                            <Badge
                              variant={rule.status === 'Enabled' ? 'default' : 'secondary'}
                              className="text-xs"
                            >
                              {rule.status}
                            </Badge>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <LifecycleRuleDetails rule={rule} />
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                )}
              </div>
            </>
          ) : null}

              {showSeparator && <Separator />}
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Export Profiles</h3>
                <p className="text-sm text-muted-foreground">
                  Export decrypted credentials as config profiles.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExportProfile('aws')}
                    disabled={exportBusy}
                  >
                    {exportingFormat === 'aws' && (
                      <Spinner size="sm" className="mr-2 text-current" />
                    )}
                    Export AWS Profile
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExportProfile('rclone')}
                    disabled={exportBusy}
                  >
                    {exportingFormat === 'rclone' && (
                      <Spinner size="sm" className="mr-2 text-current" />
                    )}
                    Export rclone Profile
                  </Button>
                </div>
              </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
