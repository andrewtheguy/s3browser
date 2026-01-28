import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.js';
import objectsRoutes from './routes/objects.js';
import uploadRoutes, { cleanupUploadTracker } from './routes/upload.js';
import downloadRoutes from './routes/download.js';

// Embedded frontend assets (Bun embeds these at compile time)
import indexHtml from '../dist/index.html' with { type: 'text' };
import indexJs from '../dist/assets/index.js' with { type: 'text' };
import indexCss from '../dist/assets/index.css' with { type: 'text' };

// Asset map for serving
const embeddedAssets: Record<string, { content: string; mime: string }> = {
  '/index.html': { content: indexHtml as string, mime: 'text/html' },
  '/assets/index.js': { content: indexJs as string, mime: 'application/javascript' },
  '/assets/index.css': { content: indexCss as string, mime: 'text/css' },
};

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(cookieParser());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/objects', objectsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/download', downloadRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Serve embedded static assets
app.get('/{*splat}', (req, res) => {
  let assetPath = req.path;

  // Serve index.html for root and non-asset paths (SPA routing)
  if (assetPath === '/' || !embeddedAssets[assetPath]) {
    assetPath = '/index.html';
  }

  const asset = embeddedAssets[assetPath];
  if (asset) {
    res.setHeader('Content-Type', asset.mime);
    res.send(asset.content);
  } else {
    res.status(404).send('Not found');
  }
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`S3 Browser running at http://localhost:${PORT}`);
});

// Graceful shutdown
let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('Shutting down gracefully...');

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
