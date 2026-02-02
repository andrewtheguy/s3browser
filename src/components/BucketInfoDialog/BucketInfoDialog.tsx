import { useState, useEffect } from 'react';
import { useParams } from 'react-router';
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
      setIsLoading(false);
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
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bucket Settings</DialogTitle>
        </DialogHeader>
        <div>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="lg" />
            </div>
          ) : error ? (
            <p className="text-destructive">{error}</p>
          ) : info ? (
            <div className="space-y-4">
              <Table>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium w-[140px]">
                      Bucket
                    </TableCell>
                    <TableCell>{bucket}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">
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
                          <Badge variant="outline" className="text-yellow-600">
                            MFA Delete
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">
                      Default Encryption
                    </TableCell>
                    <TableCell>
                      {info.encryptionError ? (
                        <div>
                          <Badge variant="outline" className="text-yellow-600">Unknown</Badge>
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
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
