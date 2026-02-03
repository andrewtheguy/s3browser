import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Trash2, LogOut, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useS3Client, useConnectionHistory } from '../../hooks';
import { buildBrowseUrl, buildSelectBucketUrl } from '../../utils/urlEncoding';
import type { S3ConnectionCredentials } from '../../types';

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
  if (!value) return false;
  // Allow only letters, numbers, dashes, underscores, and dots
  // Enforce length between 1 and 64 characters
  if (value.length > 64) return false;
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

interface S3ConnectionFormProps {
  error: string | null;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  onLogout: () => void;
}

export function S3ConnectionForm({
  error,
  isLoading,
  setIsLoading,
  onLogout,
}: S3ConnectionFormProps) {
  const navigate = useNavigate();
  const { connect, isLoggedIn, activeConnectionId, credentials: activeCredentials, isConnected } = useS3Client();
  const { connections, deleteConnection, isLoading: connectionsLoading } = useConnectionHistory(isLoggedIn);

  // Check if we can continue browsing (have an active connection)
  const canContinueBrowsing = isConnected && activeConnectionId;
  const [autoDetectRegion, setAutoDetectRegion] = useState(true);
  const [endpointTouched, setEndpointTouched] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<number | null>(null);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const [wantsToChangeSecretKey, setWantsToChangeSecretKey] = useState(false);
  const [formData, setFormData] = useState({
    connectionName: '',
    region: '',
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
    endpoint: 'https://s3.amazonaws.com',
  });

  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.body.removeAttribute('data-select-open');
      }
    };
  }, []);

  const endpointValid = isValidUrl(formData.endpoint);
  const showEndpointError = endpointTouched && !endpointValid;
  const nameValid = isValidConnectionName(formData.connectionName);
  const showNameError = nameTouched && !nameValid;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const credentials: S3ConnectionCredentials = {
        accessKeyId: formData.accessKeyId,
        secretAccessKey: formData.secretAccessKey,
        bucket: formData.bucket || undefined,
        region: autoDetectRegion ? undefined : formData.region || undefined,
        endpoint: formData.endpoint || undefined,
        connectionName: formData.connectionName.trim(),
        autoDetectRegion,
        connectionId: selectedConnectionId ?? undefined,
      };
      const result = await connect(credentials);

      if (!result.success || !result.connectionId) {
        return;
      }

      setEndpointTouched(false);
      setNameTouched(false);

      if (formData.bucket) {
        void navigate(buildBrowseUrl(result.connectionId, formData.bucket, ''), { replace: true });
      } else {
        void navigate(buildSelectBucketUrl(result.connectionId), { replace: true });
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

  const handleConnectionChange = (value: string) => {
    if (value === 'new') {
      setSelectedConnectionId(null);
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
      setWantsToChangeSecretKey(false);
      return;
    }

    const id = parseInt(value, 10);
    const connection = connections.find((c) => c.id === id);
    if (connection) {
      setSelectedConnectionId(connection.id);
      setFormData({
        connectionName: connection.name,
        endpoint: connection.endpoint,
        accessKeyId: connection.accessKeyId,
        bucket: connection.bucket || '',
        region: connection.region || '',
        secretAccessKey: '',
      });
      setAutoDetectRegion(connection.autoDetectRegion);
      setEndpointTouched(false);
      setNameTouched(false);
      setWantsToChangeSecretKey(false);
    }
  };

  const handleDeleteConnection = async (e: React.MouseEvent, connectionId: number, name: string) => {
    e.stopPropagation();
    e.preventDefault();
    setDeletionError(null);
    try {
      await deleteConnection(connectionId);
      if (selectedConnectionId === connectionId) {
        setSelectedConnectionId(null);
        setFormData({
          connectionName: '',
          endpoint: 'https://s3.amazonaws.com',
          accessKeyId: '',
          bucket: '',
          region: '',
          secretAccessKey: '',
        });
        setAutoDetectRegion(true);
        setWantsToChangeSecretKey(false);
      }
    } catch (err) {
      console.error('Failed to delete connection:', err);
      const message = err instanceof Error ? err.message : 'Failed to delete connection';
      setDeletionError(`Could not delete "${name}": ${message}`);
    }
  };

  const handleSelectOpenChange = (open: boolean) => {
    if (typeof document === 'undefined') {
      return;
    }
    if (open) {
      document.body.setAttribute('data-select-open', 'true');
    } else {
      document.body.removeAttribute('data-select-open');
    }
  };

  // Secret key is optional when using an existing saved connection (unless user wants to change it)
  const isExistingConnection = selectedConnectionId !== null;
  const secretKeyRequired = !isExistingConnection || wantsToChangeSecretKey;
  const isFormValid =
    (autoDetectRegion || formData.bucket || formData.region) &&
    formData.connectionName.trim() &&
    formData.accessKeyId &&
    (!secretKeyRequired || formData.secretAccessKey) &&
    endpointValid &&
    nameValid;

  return (
    <>
      <div className="flex items-center justify-end mb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
        >
          <LogOut className="h-4 w-4 mr-2" />
          Sign Out
        </Button>
      </div>

      <Separator className="mb-4" />

      {deletionError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription className="flex items-center justify-between">
            {deletionError}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setDeletionError(null)}
            >
              ×
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {canContinueBrowsing && (
        <Button
          variant="outline"
          className="w-full mb-4"
          onClick={() => {
            if (activeCredentials?.bucket) {
              void navigate(buildBrowseUrl(activeConnectionId, activeCredentials.bucket, ''));
            } else {
              void navigate(buildSelectBucketUrl(activeConnectionId));
            }
          }}
        >
          <ArrowRight className="h-4 w-4 mr-2" />
          Continue Browsing{activeCredentials?.bucket ? ` (${activeCredentials.bucket})` : ''}
        </Button>
      )}

      <p className="text-sm text-muted-foreground text-center mb-4">
        {canContinueBrowsing ? 'Or connect to a different S3 storage' : 'Enter your S3 credentials to browse storage'}
      </p>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2 mb-4">
        <Label htmlFor="connection-select">Saved Connection</Label>
        <Select
          value={selectedConnectionId !== null ? String(selectedConnectionId) : 'new'}
          onValueChange={handleConnectionChange}
          onOpenChange={handleSelectOpenChange}
          disabled={connectionsLoading}
        >
          <SelectTrigger id="connection-select">
            <SelectValue placeholder="Select a connection" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">New Connection</SelectItem>
            {connections.map((connection) => (
              <SelectItem key={connection.id} value={String(connection.id)}>
                <div className="flex items-center justify-between w-full gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{connection.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {connection.bucket ? `${connection.bucket} @ ${connection.endpoint}` : connection.endpoint}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={(e) => handleDeleteConnection(e, connection.id, connection.name)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="connectionName">Connection Name</Label>
          <Input
            id="connectionName"
            value={formData.connectionName}
            onChange={handleChange('connectionName')}
            onBlur={() => setNameTouched(true)}
            autoComplete="off"
            placeholder="my-aws-account"
            required
            className={showNameError ? 'border-destructive' : ''}
          />
          <p className={`text-xs ${showNameError ? 'text-destructive' : 'text-muted-foreground'}`}>
            {showNameError
              ? 'Connection name cannot contain spaces'
              : 'A unique name for this connection (no spaces).'}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="endpoint">Endpoint URL</Label>
          <Input
            id="endpoint"
            value={formData.endpoint}
            onChange={handleChange('endpoint')}
            onBlur={() => setEndpointTouched(true)}
            autoComplete="off"
            className={showEndpointError ? 'border-destructive' : ''}
          />
          <p className={`text-xs ${showEndpointError ? 'text-destructive' : 'text-muted-foreground'}`}>
            {showEndpointError
              ? 'Please enter a valid URL (e.g., https://s3.amazonaws.com)'
              : 'Default is AWS S3. Change for S3-compatible services (MinIO, etc.)'}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="accessKeyId">Access Key ID</Label>
          <Input
            id="accessKeyId"
            value={formData.accessKeyId}
            onChange={handleChange('accessKeyId')}
            required
            autoComplete="off"
          />
        </div>

        {isExistingConnection && !wantsToChangeSecretKey ? (
          <div className="space-y-2">
            <Label htmlFor="secretAccessKey">Secret Access Key</Label>
            <Input
              id="secretAccessKey"
              type="password"
              value="••••••••••••••••"
              disabled
            />
            <p className="text-xs text-muted-foreground">Key is stored securely on the server</p>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0"
              onClick={() => setWantsToChangeSecretKey(true)}
            >
              Change Secret Key
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="secretAccessKey">
              {isExistingConnection ? 'New Secret Access Key' : 'Secret Access Key'}
            </Label>
            <div className="flex gap-2">
              <Input
                id="secretAccessKey"
                type="password"
                value={formData.secretAccessKey}
                onChange={handleChange('secretAccessKey')}
                required
                autoComplete="off"
                className="flex-1"
              />
              {isExistingConnection && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setWantsToChangeSecretKey(false);
                    setFormData((prev) => ({ ...prev, secretAccessKey: '' }));
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="bucket">Bucket Name</Label>
          <Input
            id="bucket"
            value={formData.bucket}
            onChange={handleChange('bucket')}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to list available buckets after login
          </p>
        </div>

        <div className="flex items-center space-x-2 pt-2">
          <Checkbox
            id="autoDetectRegion"
            checked={autoDetectRegion}
            onCheckedChange={(checked) => setAutoDetectRegion(checked === true)}
          />
          <Label htmlFor="autoDetectRegion" className="cursor-pointer">
            Auto-detect region from bucket
          </Label>
        </div>

        {!autoDetectRegion && (
          <div className="space-y-2">
            <Label htmlFor="region">Region</Label>
            <Input
              id="region"
              value={formData.region}
              onChange={handleChange('region')}
              required
              autoComplete="off"
              placeholder="us-east-1"
            />
          </div>
        )}

        <Button
          type="submit"
          className="w-full"
          size="lg"
          disabled={!isFormValid || isLoading}
        >
          {isLoading ? <Spinner size="sm" className="text-white" /> : 'Connect'}
        </Button>
      </form>
    </>
  );
}
