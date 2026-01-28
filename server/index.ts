import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.js';
import objectsRoutes from './routes/objects.js';
import uploadRoutes, { cleanupUploadTracker } from './routes/upload.js';
import downloadRoutes from './routes/download.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/objects', objectsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/download', downloadRoutes);

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

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
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

  server.close((err) => {
    if (err) {
      console.error('Error closing server:', err);
      process.exit(1);
    }
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
