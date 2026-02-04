import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import { getDb, closeDb } from './db/index.js';
import authRoutes from './routes/auth.js';
import objectsRoutes from './routes/objects.js';
import uploadRoutes, { cleanupUploadTracker } from './routes/upload.js';
import downloadRoutes from './routes/download.js';
import bucketRoutes from './routes/bucket.js';
import { clearBucketRegionCache } from './middleware/auth.js';

// Initialize database (validates encryption key and creates tables)
try {
  getDb();
  console.log('Database initialized successfully');
} catch (error) {
  console.error('Failed to initialize database:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3001;
const HOST = process.env.HOST || 'localhost';
// Middleware
app.use(express.json({
  type: (req) => {
    const rawUrl = typeof req.url === 'string' ? req.url : '';
    const path = rawUrl.split('?')[0] || '';
    if (path.startsWith('/api/upload/') && (path.endsWith('/single') || path.endsWith('/part'))) {
      return false;
    }
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string') return false;
    return contentType.includes('application/json') || contentType.includes('+json');
  },
}));
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/objects', objectsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/bucket', bucketRoutes);

// Serve static frontend assets (production build)
const distPath = path.resolve(process.cwd(), 'dist');
app.use(express.static(distPath));

const indexPath = path.join(distPath, 'index.html');
const serveIndexWithCacheClear = (_req: Request, res: Response) => {
  clearBucketRegionCache();
  return res.sendFile(indexPath);
};

app.get(['/', '/connection/:connectionId/select-bucket'], serveIndexWithCacheClear);

// SPA fallback: serve index.html for non-API GET routes
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    return next();
  }
  return res.sendFile(indexPath);
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Global error handler - catches unhandled errors from async routes
app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);

  // If headers already sent, delegate to Express's default error handler
  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});

// Handle server errors (e.g., port in use)
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: Port ${PORT} is already in use`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});

// Graceful shutdown
let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log('Shutting down gracefully...');

  // Force exit after 10 seconds if graceful shutdown hangs
  const forceExitTimeout = setTimeout(() => {
    console.error('Forced exit after timeout');
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  try {
    cleanupUploadTracker();
  } catch (err) {
    console.error('Error during upload tracker cleanup:', err);
  }

  if (!server.listening) {
    try {
      closeDb();
    } catch (err) {
      console.error('Error closing database:', err);
    }
    process.exit(0);
  }

  server.close((err) => {
    if (err) {
      console.error('Error closing server:', err);
    } else {
      console.log('Server closed');
    }

    try {
      closeDb();
    } catch (dbErr) {
      console.error('Error closing database:', dbErr);
    }

    process.exit(err ? 1 : 0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
