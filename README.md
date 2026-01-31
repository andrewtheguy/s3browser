# S3 Browser

A web-based file manager for AWS S3 and S3-compatible storage services (MinIO, DigitalOcean Spaces, etc.).

## Features

- Browse S3 buckets with folder navigation
- Upload files up to 5GB with multipart upload and resume support
- Download files via presigned URLs
- Create folders
- Delete files
- Auto-detect bucket region or specify manually
- Support for custom S3-compatible endpoints
- User authentication with username/password
- Save and manage multiple S3 connection profiles
- Persistent sessions across server restarts

## Quick Install (Linux & macOS)

Requires [GitHub CLI](https://cli.github.com/) (`gh`) to be installed and authenticated.

```bash
gh api repos/andrewtheguy/s3browser/contents/install.sh --jq '.content' | base64 -d | bash
```

To install a specific version:

```bash
gh api repos/andrewtheguy/s3browser/contents/install.sh --jq '.content' | base64 -d | bash -s v1.0.0
```

## Tech Stack

- **Frontend**: React, TypeScript, Material-UI
- **Backend**: Express, AWS SDK v3, SQLite (bun:sqlite)
- **Build**: Vite (frontend bundler), Bun (runtime, package manager, standalone compiler)

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) 1.0+

### Installation

```bash
bun install
```

### Configuration

An encryption key is required to securely store S3 credentials. Provide it via one of:

**Option 1: Environment variable**
```bash
export S3BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

**Option 2: Key file** (recommended for standalone)
```bash
mkdir -p ~/.s3browser
openssl rand -hex 32 > ~/.s3browser/encryption.key
chmod 600 ~/.s3browser/encryption.key
```

You can also copy `.env.example` to `.env` for development:
```bash
cp .env.example .env
# Edit .env and set your encryption key
```

### Register a User

Users are registered via the CLI (for security):

```bash
bun run register -u myusername
# Enter password when prompted (min 8 characters)
```

### Development

Start both the frontend and backend in development mode:

```bash
bun run dev
```

The frontend runs on `http://localhost:5173` and proxies API requests to the backend on `http://localhost:3001`.

### Production Build

```bash
bun run build
```

### Standalone Executable

Build a self-contained executable with embedded frontend assets:

```bash
bun run build:standalone
```

This creates an `s3browser` executable that can be run from anywhere without dependencies. By default, it builds for the current platform (macOS, Linux, or Windows).

```bash
./s3browser
./s3browser -b :8080
./s3browser --bind 127.0.0.1:3000
./s3browser --bind [::1]:3000
```

Run `./s3browser --help` for all options.

## Usage

### Login Flow

1. **Sign in** with your username and password
2. **Enter S3 credentials** (Access Key ID, Secret Access Key, endpoint)
3. **Select or enter a bucket** to browse
4. Optionally **save the connection** with a name for quick access later

### Connecting to AWS S3

1. Sign in with your user account
2. Enter your AWS Access Key ID and Secret Access Key
3. Enter the bucket name (or leave empty to list available buckets)
4. Optionally check "Auto-detect region" or enter the region manually (e.g., `us-east-1`)

### Connecting to S3-Compatible Services

For MinIO, DigitalOcean Spaces, or other S3-compatible services:

1. Sign in with your user account
2. Enter your access credentials
3. Enter the custom endpoint URL (e.g., `http://localhost:9000` for local MinIO)
4. Enter the bucket name
5. Enter the region if required by the service

### Saved Connections

After successfully connecting, you can save the connection profile:

1. Enter a connection name (no spaces)
2. The endpoint and access key ID are saved (encrypted)
3. Secret keys are never saved - you'll need to enter them each time
4. Select a saved connection from the dropdown to quickly fill in credentials

## Data Storage

All data is stored in `~/.s3browser/`:

| File | Purpose |
|------|---------|
| `s3browser.db` | SQLite database (users, sessions, saved connections) |
| `encryption.key` | Optional encryption key file |

## Limitations

- Maximum file size: 5GB
- Session expires after 4 hours

## Security

- User passwords hashed with bcrypt (12 rounds)
- S3 credentials encrypted with AES-256-GCM at rest
- Encryption key required via environment variable or key file
- Sessions stored in SQLite (persistent across restarts)
- HTTP-only secure cookies for session management
- Path traversal protection on all file operations
- CLI-only user registration prevents unauthorized account creation
- Database directory secured with 0700 permissions

## License

MIT
