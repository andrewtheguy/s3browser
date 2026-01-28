# S3 Browser

A web-based file browser for AWS S3 and S3-compatible storage services (MinIO, DigitalOcean Spaces, etc.).

## Features

- Browse S3 buckets with folder navigation
- Upload files (max 100MB per file)
- Download files via presigned URLs
- Create folders
- Delete files and folders
- Auto-detect bucket region or specify manually
- Support for custom S3-compatible endpoints

## Tech Stack

- **Frontend**: React, TypeScript, Material-UI
- **Backend**: Express, AWS SDK v3
- **Build**: Vite

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Development

Start both the frontend and backend in development mode:

```bash
# Terminal 1: Start the backend server
npm run server

# Terminal 2: Start the frontend dev server
npm run dev
```

The frontend runs on `http://localhost:5173` and proxies API requests to the backend on `http://localhost:3001`.

### Production Build

```bash
npm run build
```

## Configuration

### Connecting to AWS S3

1. Enter your AWS Access Key ID and Secret Access Key
2. Enter the bucket name
3. Optionally check "Auto-detect region" or enter the region manually (e.g., `us-east-1`)

### Connecting to S3-Compatible Services

For MinIO, DigitalOcean Spaces, or other S3-compatible services:

1. Enter your access credentials
2. Enter the bucket name
3. Enter the custom endpoint URL (e.g., `http://localhost:9000` for local MinIO)
4. Enter the region if required by the service

## Limitations

- Maximum file size: 100MB
- Session expires after 4 hours
- Files are uploaded to memory before being sent to S3 (not suitable for very large files)

## Security

- Credentials are stored server-side in memory (never exposed to the browser)
- Sessions use HTTP-only cookies
- Path traversal protection on all file operations
- User uploads are scoped to session-specific prefixes

## License

MIT
