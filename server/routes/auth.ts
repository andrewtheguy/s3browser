import { Router, Request, Response } from 'express';
import {
  validateCredentials,
  validateCredentialsOnly,
  getBucketRegion,
  S3Credentials,
  loginMiddleware,
  s3Middleware,
  AuthenticatedRequest,
  listUserBuckets,
  validateBucket,
  normalizeEndpoint,
  detectS3Vendor,
  clearBucketRegionCache,
} from '../middleware/auth.js';
import {
  getAllConnections,
  saveConnection,
  deleteConnectionById,
  getConnectionById,
  decryptConnectionSecretKey,
  isUniqueConstraintError,
} from '../db/index.js';
import { getLoginPassword, timingSafeCompare } from '../db/crypto.js';
import { createAuthToken, verifyAuthToken, AUTH_COOKIE_OPTIONS, AUTH_COOKIE_NAME } from '../auth/token.js';

interface LoginRequestBody {
  password?: string;
}

interface S3CredentialsRequestBody {
  connectionId?: number;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
  endpoint?: string;
  connectionName?: string;
  autoDetectRegion?: boolean;
}

interface SelectBucketRequestBody {
  bucket?: string;
}

type ExportProfileFormat = 'aws' | 'rclone';

interface ExportProfileRequestBody {
  format?: ExportProfileFormat;
}

interface ExportProfileResponse {
  filename: string;
  content: string;
}

interface DbConnectionRow {
  id: number;
  name: string;
  endpoint: string;
  access_key_id: string;
  bucket: string | null;
  region: string;
  auto_detect_region: number;
  last_used_at: number;
}

const router = Router();

function sanitizeProfileName(name: string, fallback: string): string {
  const trimmed = name.trim();
  const base = trimmed.length > 0 ? trimmed : fallback;
  return base.replace(/[^a-zA-Z0-9+=,.@_-]/g, '_');
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return 's3-connection';
  }

  let result = '';
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const code = trimmed.charCodeAt(i);
    if (
      code <= 0x1f
      || code === 0x7f
      || (code >= 0x80 && code <= 0x9f)
      || char === '\\'
      || char === '/'
      || char === ':'
      || char === '*'
      || char === '?'
      || char === '"'
      || char === '<'
      || char === '>'
      || char === '|'
      || /\s/.test(char)
    ) {
      result += '_';
    } else {
      result += char;
    }
  }

  let sanitized = result.replace(/[. ]+$/g, '');

  if (!sanitized) {
    return 's3-connection';
  }

  const reservedNames = new Set([
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ]);

  if (reservedNames.has(sanitized.toUpperCase())) {
    sanitized = `_${sanitized}`;
  }

  return sanitized || 's3-connection';
}

function buildAwsProfile(
  profileName: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  endpoint?: string
): string {
  const header = profileName === 'default' ? '[default]' : `[profile ${profileName}]`;
  const lines = [
    header,
    `region = ${region}`,
    'output = json',
  ];

  if (endpoint) {
    lines.push(`endpoint_url = ${endpoint}`);
  }

  lines.push(
    `aws_access_key_id = ${accessKeyId}`,
    `aws_secret_access_key = ${secretAccessKey}`,
    ''
  );

  return lines.join('\n');
}

function buildRcloneProfile(
  profileName: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string | null,
  provider: string,
  endpoint?: string
): string {
  const lines = [
    `[${profileName}]`,
    'type = s3',
    `provider = ${provider}`,
    `access_key_id = ${accessKeyId}`,
    `secret_access_key = ${secretAccessKey}`,
  ];

  if (region) {
    lines.push(`region = ${region}`);
  }
  if (endpoint) {
    lines.push(`endpoint = ${endpoint}`);
  }

  lines.push('');
  return lines.join('\n');
}

// POST /api/auth/login - Authenticate with password
router.post('/login', (req: Request, res: Response): void => {
  const body = req.body as LoginRequestBody;
  const { password } = body;

  if (!password) {
    res.status(400).json({ error: 'Password is required' });
    return;
  }

  let loginPassword: string;
  try {
    loginPassword = getLoginPassword();
  } catch (error) {
    console.error('Failed to get login password:', error);
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  if (!timingSafeCompare(password, loginPassword)) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const token = createAuthToken();

  // Set HTTP-only session cookie (expires when browser closes, server validates expiry in token)
  res.cookie(AUTH_COOKIE_NAME, token, AUTH_COOKIE_OPTIONS);

  res.json({ success: true });
});

// POST /api/auth/logout
router.post('/logout', (_req: Request, res: Response): void => {
  clearBucketRegionCache();
  res.clearCookie(AUTH_COOKIE_NAME);
  res.json({ success: true });
});

// GET /api/auth/status
router.get('/status', (req: Request, res: Response): void => {
  const token = req.cookies?.[AUTH_COOKIE_NAME] as string | undefined;

  if (!token || !verifyAuthToken(token)) {
    res.clearCookie(AUTH_COOKIE_NAME);
    res.json({ authenticated: false });
    return;
  }

  res.json({ authenticated: true });
});

// POST /api/auth/connections - Save a new S3 connection or update existing
router.post('/connections', loginMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as S3CredentialsRequestBody;
  const { connectionId, accessKeyId, secretAccessKey, region, bucket, endpoint, connectionName, autoDetectRegion } = body;

  if (!accessKeyId) {
    res.status(400).json({ error: 'Access key ID is required' });
    return;
  }

  if (!connectionName) {
    res.status(400).json({ error: 'Connection name is required' });
    return;
  }

  // Look up existing connection by ID if provided
  let existingConnection;
  if (connectionId !== undefined) {
    if (typeof connectionId !== 'number' || !Number.isInteger(connectionId) || connectionId <= 0) {
      res.status(400).json({ error: 'Invalid connection ID' });
      return;
    }
    existingConnection = getConnectionById(connectionId);
    if (!existingConnection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
  }

  // For existing connections, secret key is optional (use stored key if not provided)
  // For new connections, secret key is required
  let effectiveSecretKey: string;

  if (secretAccessKey === undefined || secretAccessKey === '') {
    if (!existingConnection) {
      res.status(400).json({ error: 'Secret access key is required for new connections' });
      return;
    }
    // Use existing secret key for validation
    effectiveSecretKey = decryptConnectionSecretKey(existingConnection);
  } else {
    effectiveSecretKey = secretAccessKey;
  }

  // If bucket is provided, use existing flow with region detection
  // If no bucket, use a default region (us-east-1) or provided region
  let detectedRegion = region;

  if (bucket) {
    // Auto-detect region from bucket if not provided
    if (!detectedRegion) {
      try {
        detectedRegion = await getBucketRegion(accessKeyId, effectiveSecretKey, bucket, endpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to detect region';
        res.status(400).json({ error: message });
        return;
      }
    }
  } else {
    // No bucket provided - use default region if not specified
    detectedRegion = detectedRegion || 'us-east-1';
  }

  const credentials: S3Credentials = {
    accessKeyId,
    secretAccessKey: effectiveSecretKey,
    region: detectedRegion,
    bucket: bucket || undefined,
    endpoint: endpoint || undefined,
  };

  // Always validate credentials before saving
  let validation;
  try {
    if (bucket) {
      validation = await validateCredentials(credentials);
    } else {
      validation = await validateCredentialsOnly(accessKeyId, effectiveSecretKey, detectedRegion, endpoint);
    }
  } catch (error) {
    console.error('Credential validation failed:', error);
    res.status(500).json({ error: 'Failed to validate credentials' });
    return;
  }

  if (!validation.valid) {
    res.status(401).json({ error: validation.error || 'Invalid credentials' });
    return;
  }

  // Save the connection (secretAccessKey is null if not provided - keeps existing)
  let savedConnection;
  try {
    savedConnection = saveConnection(
      connectionId ?? null,
      connectionName.trim(),
      endpoint || '',
      accessKeyId,
      secretAccessKey || null,
      bucket || null,
      detectedRegion,
      autoDetectRegion !== false
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      res.status(400).json({ error: 'Connection name already exists' });
      return;
    }
    console.error('saveConnection failed:', error);
    res.status(500).json({ error: 'Failed to save connection' });
    return;
  }

  res.json({
    success: true,
    connectionId: savedConnection.id,
    region: detectedRegion,
    bucket: bucket || null,
    endpoint: endpoint || null,
  });
});

// GET /api/auth/connections - List saved S3 connections
// Note: secretAccessKey is never returned to client for security
router.get('/connections', loginMiddleware, (_req: AuthenticatedRequest, res: Response): void => {
  // Clear bucket region cache on page load/refresh
  clearBucketRegionCache();

  const fetchAllConnections = getAllConnections as () => DbConnectionRow[];
  const connections = fetchAllConnections();

  const sanitizedConnections = connections.map(conn => ({
    id: conn.id,
    name: conn.name,
    endpoint: conn.endpoint,
    accessKeyId: conn.access_key_id,
    bucket: conn.bucket,
    region: conn.region,
    autoDetectRegion: conn.auto_detect_region === 1,
    lastUsedAt: conn.last_used_at * 1000, // Convert to ms
  }));

  res.json({ connections: sanitizedConnections });
});

// GET /api/auth/connections/:id - Get a specific connection by ID
// Note: secretAccessKey is never returned to client for security
router.get('/connections/:id', loginMiddleware, (req: AuthenticatedRequest, res: Response): void => {
  const connectionId = parseInt(req.params.id as string, 10);

  if (isNaN(connectionId)) {
    res.status(400).json({ error: 'Invalid connection ID' });
    return;
  }

  const connection = getConnectionById(connectionId);
  if (!connection) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  res.json({
    id: connection.id,
    name: connection.name,
    endpoint: connection.endpoint,
    accessKeyId: connection.access_key_id,
    bucket: connection.bucket,
    region: connection.region,
    autoDetectRegion: connection.auto_detect_region === 1,
    lastUsedAt: connection.last_used_at * 1000,
  });
});

// DELETE /api/auth/connections/:id - Delete a saved connection by ID
router.delete('/connections/:id', loginMiddleware, (req: AuthenticatedRequest, res: Response): void => {
  const connectionId = parseInt(req.params.id as string, 10);

  if (isNaN(connectionId) || connectionId <= 0) {
    res.status(400).json({ error: 'Valid connection ID is required' });
    return;
  }

  const deleted = deleteConnectionById(connectionId);
  if (!deleted) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  res.json({ success: true });
});

// GET /api/auth/buckets/:connectionId - List available buckets for a connection
router.get('/buckets/:connectionId', s3Middleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const client = req.s3Client!;

  try {
    const buckets = await listUserBuckets(client);
    res.json({ buckets });
  } catch (error: unknown) {
    console.error('Failed to list buckets:', error);

    if (error instanceof Error) {
      const signatureErrorNames = ['SignatureDoesNotMatch', 'InvalidAccessKeyId', 'ExpiredToken', 'InvalidToken'];
      const isSignatureError =
        signatureErrorNames.some(n => error?.name === n || error?.name?.toLowerCase() === n.toLowerCase()) ||
        error.message?.toLowerCase().includes('signature') ||
        error.message?.toLowerCase().includes('credential');

      if (isSignatureError) {
        res.status(401).json({
          error: 'Authentication failed',
          message: error.message || 'Invalid signature or credentials. Check your access key, secret key, region, and endpoint.',
        });
        return;
      }

      if (error.name === 'AccessDenied' || error.name === 'Forbidden') {
        res.status(403).json({
          error: 'Access denied',
          message: 'You do not have permission to list buckets. Please enter a bucket name manually.',
        });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to list buckets' });
  }
});

// POST /api/auth/validate-bucket/:connectionId - Validate a bucket for a connection
router.post('/validate-bucket/:connectionId', s3Middleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as SelectBucketRequestBody;
  const { bucket } = body;
  const client = req.s3Client!;

  if (!bucket || typeof bucket !== 'string') {
    res.status(400).json({ error: 'Bucket name is required' });
    return;
  }

  let validation;
  try {
    validation = await validateBucket(client, bucket);
  } catch (error) {
    console.error('Failed to validate bucket:', { bucket, error });
    res.status(500).json({ error: 'Failed to validate bucket' });
    return;
  }

  if (!validation.valid) {
    res.status(400).json({ error: validation.error || 'Invalid bucket' });
    return;
  }

  res.json({ success: true, bucket });
});

// POST /api/auth/test-connection - Test S3 credentials without saving
router.post('/test-connection', loginMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as S3CredentialsRequestBody;
  const { accessKeyId, secretAccessKey, region, bucket, endpoint } = body;

  if (!accessKeyId || !secretAccessKey) {
    res.status(400).json({ error: 'Missing required credentials' });
    return;
  }

  const testRegion = region || 'us-east-1';

  let validation;
  try {
    if (bucket) {
      validation = await validateCredentials({
        accessKeyId,
        secretAccessKey,
        region: testRegion,
        bucket,
        endpoint,
      });
    } else {
      validation = await validateCredentialsOnly(accessKeyId, secretAccessKey, testRegion, endpoint);
    }
  } catch (error) {
    console.error('Credential validation failed:', error);
    res.status(500).json({ error: 'Failed to validate credentials' });
    return;
  }

  if (!validation.valid) {
    res.status(401).json({ error: validation.error || 'Invalid credentials' });
    return;
  }

  res.json({ success: true });
});

// POST /api/auth/connections/:id/export - Export connection credentials as a config profile
router.post('/connections/:id/export', loginMiddleware, (req: AuthenticatedRequest, res: Response): void => {
  const connectionId = parseInt(req.params.id as string, 10);

  if (isNaN(connectionId) || connectionId <= 0) {
    res.status(400).json({ error: 'Valid connection ID is required' });
    return;
  }

  const connection = getConnectionById(connectionId);
  if (!connection) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  const body = req.body as ExportProfileRequestBody;
  const format = body.format;

  if (format !== 'aws' && format !== 'rclone') {
    res.status(400).json({ error: 'Invalid export format' });
    return;
  }

  let decryptedSecret: string;
  try {
    decryptedSecret = decryptConnectionSecretKey(connection);
  } catch (error) {
    console.error('Failed to decrypt connection secret key for export:', {
      connectionId: connection.id,
      connectionName: connection.name,
      error,
    });
    res.status(422).json({ error: 'Failed to decrypt connection secret key' });
    return;
  }
  const profileName = sanitizeProfileName(connection.name, `connection-${connection.id}`);
  const filenameBase = sanitizeFilename(profileName);
  const normalizedEndpoint = normalizeEndpoint(connection.endpoint);
  const region = connection.region || 'us-east-1';
  let content: string;
  let filename: string;

  if (format === 'aws') {
    const endpointForAws = (() => {
      if (!normalizedEndpoint) return undefined;
      const vendor = detectS3Vendor(normalizedEndpoint);
      return vendor === 'aws' ? undefined : normalizedEndpoint;
    })();

    content = buildAwsProfile(profileName, connection.access_key_id, decryptedSecret, region, endpointForAws);
    filename = `${filenameBase}.aws-config`;
  } else {
    const provider = (() => {
      const vendor = detectS3Vendor(normalizedEndpoint);
      if (vendor === 'b2') return 'Backblaze';
      if (vendor === 'aws') return 'AWS';
      return 'Other';
    })();

    content = buildRcloneProfile(
      profileName,
      connection.access_key_id,
      decryptedSecret,
      region,
      provider,
      normalizedEndpoint
    );
    filename = `${filenameBase}.rclone.conf`;
  }

  const response: ExportProfileResponse = { filename, content };
  res.setHeader('Cache-Control', 'no-store');
  res.json(response);
});

export default router;
