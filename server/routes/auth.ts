import { Router, Request, Response } from 'express';
import {
  validateCredentials,
  validateCredentialsOnly,
  deleteSession,
  getSession,
  getBucketRegion,
  S3Credentials,
  authMiddleware,
  userAuthMiddleware,
  AuthenticatedRequest,
  listUserBuckets,
  updateSessionBucket,
  validateBucket,
  verifyUserAndCreateSession,
  activateConnectionOnSession,
  getConnectionForSession,
} from '../middleware/auth.js';
import {
  getConnectionsByUserId,
  saveConnection,
  deleteConnectionById,
  decryptConnectionSecretKey,
  getConnectionById,
  setSessionActiveConnection,
} from '../db/index.js';

interface UserLoginRequestBody {
  username?: string;
  password?: string;
}

interface LoginRequestBody {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
  endpoint?: string;
}

interface SelectBucketRequestBody {
  bucket?: string;
}

const router = Router();

// POST /api/auth/user-login - Authenticate user with username/password
router.post('/user-login', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as UserLoginRequestBody;
  const { username, password } = body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  let result;
  try {
    result = await verifyUserAndCreateSession(username, password);
  } catch (error) {
    console.error('verifyUserAndCreateSession failed:', error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }
  if (!result) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  // Set HTTP-only cookie with 4 hour expiry
  res.cookie('sessionId', result.sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 4 * 60 * 60 * 1000, // 4 hours
  });

  res.json({
    success: true,
    username: result.username,
  });
});

interface LoginRequestBodyExtended extends LoginRequestBody {
  connectionName?: string;
  autoDetectRegion?: boolean;
}

// POST /api/auth/login - Set S3 credentials on existing user session
router.post('/login', userAuthMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as LoginRequestBodyExtended;
  const { accessKeyId, secretAccessKey, region, bucket, endpoint, connectionName, autoDetectRegion } = body;
  const sessionId = req.sessionId!;
  const session = req.session!;

  if (!accessKeyId || !secretAccessKey) {
    res.status(400).json({ error: 'Missing required credentials' });
    return;
  }

  if (!connectionName) {
    res.status(400).json({ error: 'Connection name is required' });
    return;
  }

  // If bucket is provided, use existing flow with region detection
  // If no bucket, use a default region (us-east-1) or provided region
  let detectedRegion = region;

  if (bucket) {
    // Auto-detect region from bucket if not provided
    if (!detectedRegion) {
      try {
        detectedRegion = await getBucketRegion(accessKeyId, secretAccessKey, bucket, endpoint);
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
    secretAccessKey,
    region: detectedRegion,
    bucket: bucket || undefined,
    endpoint: endpoint || undefined,
  };

  // Always validate credentials before setting on session
  let validation;
  try {
    if (bucket) {
      validation = await validateCredentials(credentials);
    } else {
      validation = await validateCredentialsOnly(accessKeyId, secretAccessKey, detectedRegion, endpoint);
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

  // Save or update the connection in s3_connections table
  let savedConnection;
  try {
    savedConnection = saveConnection(
      session.userId,
      connectionName.trim(),
      endpoint || 'https://s3.amazonaws.com',
      accessKeyId,
      secretAccessKey,
      bucket || null,
      detectedRegion,
      autoDetectRegion !== false
    );
  } catch (error) {
    console.error('saveConnection failed:', error);
    res.status(500).json({ error: 'Failed to save connection' });
    return;
  }

  // Activate this connection on the session
  const updated = activateConnectionOnSession(sessionId, savedConnection.id, bucket || undefined);
  if (!updated) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  res.json({
    success: true,
    connectionId: savedConnection.id,
    region: detectedRegion,
    bucket: bucket || null,
    endpoint: endpoint || null,
    requiresBucketSelection: !bucket,
  });
});

// POST /api/auth/logout
router.post('/logout', (req: Request, res: Response): void => {
  const sessionId = req.cookies?.sessionId as string | undefined;

  if (sessionId) {
    deleteSession(sessionId);
  }

  res.clearCookie('sessionId');
  res.json({ success: true });
});

// GET /api/auth/status
router.get('/status', (req: Request, res: Response): void => {
  const sessionId = req.cookies?.sessionId as string | undefined;

  if (!sessionId) {
    res.json({ authenticated: false, userLoggedIn: false });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.clearCookie('sessionId');
    res.json({ authenticated: false, userLoggedIn: false });
    return;
  }

  // User is logged in but may not have S3 credentials yet
  const s3Connected = !!(session.credentials && session.client);

  res.json({
    authenticated: s3Connected,
    userLoggedIn: true,
    username: session.username,
    activeConnectionId: session.activeConnectionId || null,
    region: session.credentials?.region || null,
    bucket: session.credentials?.bucket || null,
    endpoint: session.credentials?.endpoint || null,
    requiresBucketSelection: s3Connected && !session.credentials?.bucket,
  });
});

// GET /api/auth/connections/:id - Get a specific connection by ID
router.get('/connections/:id', userAuthMiddleware, (req: AuthenticatedRequest, res: Response): void => {
  const session = req.session!;
  const connectionId = parseInt(req.params.id as string, 10);

  if (isNaN(connectionId)) {
    res.status(400).json({ error: 'Invalid connection ID' });
    return;
  }

  const connection = getConnectionById(connectionId, session.userId);
  if (!connection) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  res.json({
    id: connection.id,
    name: connection.name,
    endpoint: connection.endpoint,
    accessKeyId: connection.access_key_id,
    secretAccessKey: decryptConnectionSecretKey(connection),
    bucket: connection.bucket,
    region: connection.region,
    autoDetectRegion: connection.auto_detect_region === 1,
    lastUsedAt: connection.last_used_at * 1000,
  });
});

// POST /api/auth/activate-connection/:id - Activate a saved connection
router.post('/activate-connection/:id', userAuthMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const session = req.session!;
  const sessionId = req.sessionId!;
  const connectionId = parseInt(req.params.id as string, 10);
  const { bucket } = req.body as { bucket?: string };

  if (isNaN(connectionId)) {
    res.status(400).json({ error: 'Invalid connection ID' });
    return;
  }

  const connection = getConnectionForSession(connectionId, session.userId);
  if (!connection) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  // Decrypt secret key for validation
  const secretAccessKey = decryptConnectionSecretKey(connection);
  const endpoint = connection.endpoint;
  const region = connection.region || 'us-east-1';

  // Validate credentials
  let validation;
  try {
    if (bucket) {
      validation = await validateCredentials({
        accessKeyId: connection.access_key_id,
        secretAccessKey,
        region,
        bucket,
        endpoint,
      });
    } else {
      validation = await validateCredentialsOnly(connection.access_key_id, secretAccessKey, region, endpoint);
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

  // Activate the connection on the session
  const updated = activateConnectionOnSession(sessionId, connectionId, bucket);
  if (!updated) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  res.json({
    success: true,
    connectionId,
    region,
    bucket: bucket || null,
    endpoint: endpoint || null,
    requiresBucketSelection: !bucket,
  });
});

// GET /api/auth/buckets - List available buckets for the authenticated user
router.get('/buckets', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const session = req.session!;

  try {
    const buckets = await listUserBuckets(session.client!);
    res.json({ buckets });
  } catch (error: unknown) {
    console.error('Failed to list buckets:', error);

    if (error instanceof Error) {
      const signatureErrorNames = ['SignatureDoesNotMatch', 'InvalidAccessKeyId', 'ExpiredToken', 'AccessDenied', 'InvalidToken'];
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

// POST /api/auth/select-bucket - Select a bucket for the current session
router.post('/select-bucket', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as SelectBucketRequestBody;
  const { bucket } = body;
  const session = req.session!;
  const sessionId = req.sessionId!;

  if (!bucket || typeof bucket !== 'string') {
    res.status(400).json({ error: 'Bucket name is required' });
    return;
  }

  let validation;
  try {
    validation = await validateBucket(session.client!, bucket);
  } catch (error) {
    console.error('Failed to validate bucket:', { bucket, error });
    res.status(500).json({ error: 'Failed to validate bucket' });
    return;
  }

  if (!validation.valid) {
    res.status(400).json({ error: validation.error || 'Invalid bucket' });
    return;
  }

  const updated = updateSessionBucket(sessionId, bucket);
  if (!updated) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  res.json({
    success: true,
    bucket,
  });
});

// GET /api/auth/connections - List saved S3 connections for the user
router.get('/connections', userAuthMiddleware, (req: AuthenticatedRequest, res: Response): void => {
  const session = req.session!;

  const connections = getConnectionsByUserId(session.userId);

  const decryptedConnections = connections.map(conn => ({
    id: conn.id,
    name: conn.name,
    endpoint: conn.endpoint,
    accessKeyId: conn.access_key_id,
    secretAccessKey: decryptConnectionSecretKey(conn),
    bucket: conn.bucket,
    region: conn.region,
    autoDetectRegion: conn.auto_detect_region === 1,
    lastUsedAt: conn.last_used_at * 1000, // Convert to ms
  }));

  res.json({ connections: decryptedConnections });
});

// DELETE /api/auth/connections/:id - Delete a saved connection by ID
router.delete('/connections/:id', userAuthMiddleware, (req: AuthenticatedRequest, res: Response): void => {
  const session = req.session!;
  const sessionId = req.sessionId!;
  const connectionId = parseInt(req.params.id as string, 10);

  if (isNaN(connectionId) || connectionId <= 0) {
    res.status(400).json({ error: 'Valid connection ID is required' });
    return;
  }

  const deleted = deleteConnectionById(session.userId, connectionId);
  if (!deleted) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  // If the deleted connection was the active one, clear the session's S3 state
  if (session.activeConnectionId === connectionId) {
    setSessionActiveConnection(sessionId, null);
    session.credentials = null;
    session.client = null;
  }

  res.json({ success: true });
});

export default router;
