# S3 Browser

A web-based file manager for AWS S3 and S3-compatible storage services (MinIO, DigitalOcean Spaces, etc.).

> **Security Notice**: This application is designed for use on **private networks** or **trusted devices** only. It uses a single shared password for authentication and is not intended for public internet deployment. Do not expose this application to untrusted networks.

## Features

- Browse S3 buckets with folder navigation
- Upload files up to 5GB with multipart upload and resume support
- Download files via presigned URLs
- Create folders
- Delete files
- Auto-detect bucket region or specify manually
- Support for custom S3-compatible endpoints
- Save and manage multiple S3 connection profiles

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

Create the configuration directory and set up required credentials:

```bash
mkdir -p ~/.s3browser
chmod 700 ~/.s3browser
```

**Login Password** (required):
```bash
# Option 1: Generate random password
openssl rand -base64 32 > ~/.s3browser/login.password
chmod 600 ~/.s3browser/login.password

# Option 2: Use environment variable
export S3BROWSER_LOGIN_PASSWORD="your-password-here"
```

**Encryption Key** (required - encrypts saved S3 credentials):
```bash
# Option 1: Key file (recommended)
openssl rand -base64 32 > ~/.s3browser/encryption.key
chmod 600 ~/.s3browser/encryption.key

# Option 2: Environment variable
export S3BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)
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

1. **Sign in** with your password (from `~/.s3browser/login.password` or environment variable)
2. **Enter S3 credentials** (Access Key ID, Secret Access Key, endpoint)
3. **Select or enter a bucket** to browse
4. Optionally **save the connection** with a name for quick access later

### Connecting to AWS S3

1. Sign in with your password
2. Enter your AWS Access Key ID and Secret Access Key
3. Enter the bucket name (or leave empty to list available buckets)
4. Optionally check "Auto-detect region" or enter the region manually (e.g., `us-east-1`)

### Connecting to S3-Compatible Services

For MinIO, DigitalOcean Spaces, or other S3-compatible services:

1. Sign in with your password
2. Enter your access credentials
3. Enter the custom endpoint URL (e.g., `http://localhost:9000` for local MinIO)
4. Enter the bucket name
5. Enter the region if required by the service

### Saved Connections

After successfully connecting, you can save the connection profile:

1. Enter a connection name (no spaces)
2. All credentials are saved (secret access key encrypted with AES-256-GCM)
3. Select a saved connection from the dropdown to quickly fill in credentials

## Data Storage

All data is stored in `~/.s3browser/`:

| File | Purpose |
|------|---------|
| `s3browser.db` | SQLite database (saved connections) |
| `encryption.key` | Encryption key for S3 credentials |
| `login.password` | Login password |

## Session Behavior

- Session expires after **4 hours of inactivity**
- Each authenticated request refreshes the session timer
- Active users stay logged in indefinitely

## Limitations

- Maximum file size: 5GB

## Security

> **Important**: This application is intended for **private network** or **personal/trusted device** use only.

- Single-user authentication with password
- S3 secret access keys encrypted with AES-256-GCM at rest
- Encryption key required via environment variable or key file
- HTTP-only cookies with sliding 4-hour expiration
- Path traversal protection on all file operations
- Configuration files should be secured with 0600 permissions

**Not recommended for**:
- Public internet deployment
- Multi-tenant environments
- Untrusted networks

## License

MIT
