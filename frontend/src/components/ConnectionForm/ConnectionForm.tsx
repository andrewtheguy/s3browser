import { useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useSaveConnectionMutation, useTestConnectionMutation } from '../../queries/connections';
import type { S3ConnectionCredentials, ServerSavedConnection } from '../../services/api/auth';
import { CONNECTIONS_URL } from '../../utils/urlEncoding';
import { DeleteConnectionDialog } from '../ConnectionCard';

function isValidUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Letters, numbers, dots, underscores and hyphens; at most 64 characters. */
export function isValidProfileName(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(value);
}

interface FormData {
  profileName: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
}

type TestResult = { ok: true } | { ok: false; message: string };

interface ConnectionFormProps {
  /** When set, the form edits this connection instead of creating one. */
  connection?: ServerSavedConnection;
}

export function ConnectionForm({ connection }: ConnectionFormProps) {
  const navigate = useNavigate();
  const isEdit = connection !== undefined;
  const saveMutation = useSaveConnectionMutation();
  const testMutation = useTestConnectionMutation();

  const [formData, setFormData] = useState<FormData>({
    profileName: connection?.profileName ?? '',
    endpoint: connection?.endpoint ?? '',
    accessKeyId: connection?.accessKeyId ?? '',
    secretAccessKey: '',
    bucket: connection?.bucket ?? '',
    region: connection?.region ?? '',
  });
  const [useAwsDefault, setUseAwsDefault] = useState(!connection?.endpoint);
  const [autoDetectRegion, setAutoDetectRegion] = useState(connection?.autoDetectRegion ?? true);
  const [changeSecret, setChangeSecret] = useState(!isEdit);
  const [nameTouched, setNameTouched] = useState(false);
  const [endpointTouched, setEndpointTouched] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const endpointValid = useAwsDefault || (formData.endpoint.trim() !== '' && isValidUrl(formData.endpoint));
  const nameValid = isValidProfileName(formData.profileName.trim());
  const secretRequired = changeSecret;
  const credentialsValid =
    Boolean(formData.accessKeyId) &&
    (!secretRequired || Boolean(formData.secretAccessKey)) &&
    endpointValid &&
    (autoDetectRegion || Boolean(formData.bucket) || Boolean(formData.region));
  const formValid = credentialsValid && nameValid;
  const busy = saveMutation.isPending || testMutation.isPending;

  const update = (field: keyof FormData) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setTestResult(null);
    setFormData((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const buildCredentials = (): S3ConnectionCredentials => ({
    connectionId: connection?.id,
    profileName: formData.profileName.trim(),
    accessKeyId: formData.accessKeyId,
    secretAccessKey: changeSecret ? formData.secretAccessKey : undefined,
    bucket: formData.bucket.trim() || undefined,
    region: autoDetectRegion ? undefined : formData.region.trim() || undefined,
    endpoint: useAwsDefault ? '' : formData.endpoint.trim(),
    autoDetectRegion,
  });

  const handleTest = async () => {
    setTestResult(null);
    try {
      await testMutation.mutateAsync(buildCredentials());
      setTestResult({ ok: true });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Connection test failed' });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveMutation.mutateAsync(buildCredentials());
      toast.success(isEdit ? 'Connection saved' : 'Connection created');
      void navigate(CONNECTIONS_URL);
    } catch {
      // saveMutation.error is rendered below.
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (formValid && !busy) void handleSave();
  };

  const showNameError = nameTouched && !nameValid;
  const showEndpointError = endpointTouched && !useAwsDefault && !endpointValid;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {saveMutation.isError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{saveMutation.error.message}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="profileName">Profile name</Label>
        <Input
          id="profileName"
          value={formData.profileName}
          onChange={update('profileName')}
          onBlur={() => setNameTouched(true)}
          autoComplete="off"
          placeholder="my-aws-account"
          required
          className={showNameError ? 'border-destructive' : undefined}
        />
        <p className={`text-xs ${showNameError ? 'text-destructive' : 'text-muted-foreground'}`}>
          Letters, numbers, dots, underscores and hyphens; up to 64 characters.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox
            id="useAwsDefault"
            checked={useAwsDefault}
            onCheckedChange={(checked) => {
              setTestResult(null);
              setUseAwsDefault(checked === true);
            }}
          />
          <Label htmlFor="useAwsDefault" className="cursor-pointer">
            Use the AWS default endpoint
          </Label>
        </div>
        {!useAwsDefault && (
          <div className="space-y-2">
            <Label htmlFor="endpoint">Endpoint URL</Label>
            <Input
              id="endpoint"
              value={formData.endpoint}
              onChange={update('endpoint')}
              onBlur={() => setEndpointTouched(true)}
              placeholder="https://s3.example.com"
              autoComplete="off"
              inputMode="url"
              className={showEndpointError ? 'border-destructive' : undefined}
            />
            <p className={`text-xs ${showEndpointError ? 'text-destructive' : 'text-muted-foreground'}`}>
              {showEndpointError
                ? 'Enter a valid http(s) URL, e.g. https://s3.example.com'
                : 'For S3-compatible services such as MinIO, Backblaze B2 or Cloudflare R2.'}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="accessKeyId">Access key ID</Label>
        <Input id="accessKeyId" value={formData.accessKeyId} onChange={update('accessKeyId')} required autoComplete="off" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="secretAccessKey">{isEdit && changeSecret ? 'New secret access key' : 'Secret access key'}</Label>
        {isEdit && !changeSecret ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input id="secretAccessKey" type="password" value="••••••••••••••••" disabled className="flex-1" />
            <Button type="button" variant="outline" className="h-11 sm:h-10" onClick={() => setChangeSecret(true)}>
              Change secret
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id="secretAccessKey"
              type="password"
              value={formData.secretAccessKey}
              onChange={update('secretAccessKey')}
              required
              autoComplete="off"
              className="flex-1"
            />
            {isEdit && (
              <Button
                type="button"
                variant="ghost"
                className="h-11 sm:h-10"
                onClick={() => {
                  setChangeSecret(false);
                  setFormData((prev) => ({ ...prev, secretAccessKey: '' }));
                }}
              >
                Keep current
              </Button>
            )}
          </div>
        )}
        {isEdit && !changeSecret && (
          <p className="text-xs text-muted-foreground">The stored secret stays encrypted on the server.</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="bucket">Default bucket (optional)</Label>
        <Input id="bucket" value={formData.bucket} onChange={update('bucket')} autoComplete="off" />
        <p className="text-xs text-muted-foreground">Opening this connection goes straight to this bucket.</p>
      </div>

      <div className="space-y-2">
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox
            id="autoDetectRegion"
            checked={autoDetectRegion}
            onCheckedChange={(checked) => {
              setTestResult(null);
              setAutoDetectRegion(checked === true);
            }}
          />
          <Label htmlFor="autoDetectRegion" className="cursor-pointer">
            Detect the region from the bucket
          </Label>
        </div>
        {!autoDetectRegion && (
          <div className="space-y-2">
            <Label htmlFor="region">Region</Label>
            <Input
              id="region"
              value={formData.region}
              onChange={update('region')}
              required
              autoComplete="off"
              placeholder="us-east-1"
            />
          </div>
        )}
      </div>

      {testResult && (
        <Alert variant={testResult.ok ? 'default' : 'destructive'}>
          {testResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <AlertDescription>
            {testResult.ok ? 'Connection works: the keys were accepted.' : testResult.message}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:items-center sm:justify-end">
        {isEdit && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 text-destructive hover:text-destructive sm:mr-auto"
            onClick={() => setDeleteOpen(true)}
            disabled={busy}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        )}
        <Button type="button" variant="outline" className="h-11" onClick={() => void navigate(-1)} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => void handleTest()}
          disabled={!credentialsValid || busy}
        >
          {testMutation.isPending ? <Spinner size="sm" /> : 'Test connection'}
        </Button>
        <Button type="submit" className="h-11" disabled={!formValid || busy}>
          {saving ? <Spinner size="sm" className="text-primary-foreground" /> : 'Save'}
        </Button>
      </div>

      {connection && (
        <DeleteConnectionDialog
          connection={connection}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onDeleted={() => void navigate(CONNECTIONS_URL, { replace: true })}
        />
      )}
    </form>
  );
}
