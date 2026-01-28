import 'express-async-errors';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.js';
import objectsRoutes from './routes/objects.js';
import uploadRoutes from './routes/upload.js';
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
