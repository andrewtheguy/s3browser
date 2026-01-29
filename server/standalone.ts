import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { parseArgs } from 'util';
import authRoutes from './routes/auth.js';
import objectsRoutes from './routes/objects.js';
import uploadRoutes, { cleanupUploadTracker } from './routes/upload.js';
import downloadRoutes from './routes/download.js';

// Embedded frontend assets (Bun embeds these at compile time)
import indexHtml from '../dist/index.html' with { type: 'text' };
import indexJs from '../dist/assets/index.js' with { type: 'text' };
import indexCss from '../dist/assets/index.css' with { type: 'text' };

// Parse CLI arguments
const { values } = parseArgs({
  options: {
    bind: { type: 'string', short: 'b' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});

if (values.help) {
  console.log(`Usage: s3browser [options]

Options:
  -b, --bind <[host]:port>  Address to bind to (default: :3001)
  -h, --help                Show this help message

Examples:
  s3browser                    Listen on all interfaces, port 3001
  s3browser -b :8080           Listen on all interfaces, port 8080
  s3browser -b 127.0.0.1:3000  Listen on IPv4 localhost only
  s3browser -b [::1]:3000      Listen on IPv6 localhost only`);
  process.exit(0);
}

// Parse bind address
// Formats: :8080, 8080, 127.0.0.1:8080, [::1]:8080
// Empty host (`:8080` or `8080`) binds to all interfaces (v4+v6)
function parseBindAddress(bind: string | undefined): { host: string | undefined; port: number } {
  const defaultPort = 3001;

  if (!bind) {
    return { host: undefined, port: defaultPort };
  }

  // Just port: 8080
  if (/^\d+$/.test(bind)) {
    return { host: undefined, port: parseInt(bind, 10) };
  }

  // :port format - all interfaces
  if (/^:\d+$/.test(bind)) {
    return { host: undefined, port: parseInt(bind.slice(1), 10) };
  }

  // IPv6 with brackets: [::1]:8080
  const ipv6Match = bind.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6Match) {
    return { host: ipv6Match[1], port: parseInt(ipv6Match[2], 10) };
  }

  // IPv4 or hostname: 127.0.0.1:8080, localhost:8080
  const lastColon = bind.lastIndexOf(':');
  if (lastColon > 0) {
    const port = parseInt(bind.slice(lastColon + 1), 10);
    return {
      host: bind.slice(0, lastColon),
      port: Number.isNaN(port) ? defaultPort : port
    };
  }

  // Hostname only (no colon): localhost, 127.0.0.1
  if (bind.indexOf(':') === -1) {
    return { host: bind, port: defaultPort };
  }

  return { host: undefined, port: defaultPort };
}

const { host: HOST, port: PORT } = parseBindAddress(values.bind);

// Asset map for serving
const embeddedAssets: Record<string, { content: string; mime: string }> = {
  '/index.html': { content: indexHtml as string, mime: 'text/html' },
  '/assets/index.js': { content: indexJs as string, mime: 'application/javascript' },
  '/assets/index.css': { content: indexCss as string, mime: 'text/css' },
};

const app = express();

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
  const assetPath = req.path;

  // Serve asset if it exists
  if (embeddedAssets[assetPath]) {
    const asset = embeddedAssets[assetPath];
    res.setHeader('Content-Type', asset.mime);
    res.send(asset.content);
    return;
  }

  // Return 404 for missing asset requests (paths with extensions or /assets/ prefix)
  const isAssetRequest = assetPath.startsWith('/assets/') || /\.\w+$/.test(assetPath);
  if (isAssetRequest) {
    res.status(404).send('Not found');
    return;
  }

  // SPA fallback: serve index.html for all other routes
  const indexHtmlAsset = embeddedAssets['/index.html'];
  res.setHeader('Content-Type', indexHtmlAsset.mime);
  res.send(indexHtmlAsset.content);
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'Internal server error' });
});

const server = HOST
  ? app.listen(PORT, HOST, () => {
      const displayHost = HOST.includes(':') ? `[${HOST}]` : HOST;
      console.log(`S3 Browser running at http://${displayHost}:${PORT}`);
    })
  : app.listen(PORT, () => {
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
