# S3 Browser

A web-based file manager for AWS S3 and S3-compatible storage services (Backblaze B2, GarageHQ, etc.).

> [!WARNING]
> This is pre-release software (0.0.x). No compatibility between versions is guaranteed while the version remains 0.0.x. It has been used for basic operations with S3, Backblaze B2, and GarageHQ, but it is not extensively tested yet, particularly around error handling.

> [!CAUTION]
> This application is designed for use on **private networks** or **trusted devices** only. It uses a single shared password for authentication and is not intended for public internet deployment. Do not expose this application to untrusted networks.

## Features

- Browse S3 buckets with folder navigation
- Upload files and folders up to 5GB per file with multipart upload and in-session retry/resume support
- Download individual files and folder contents through the authenticated server proxy (no direct S3 URLs exposed to the browser)
- Create folders
- Delete files
- Copy and move files or folders
- Preview common text, PDF, image, video, and audio files
- Auto-detect bucket region or specify manually
- Support for custom S3-compatible endpoints
- Save and manage multiple S3 connection profiles

## Vendor Support

Current vendor detection (based on endpoint):

- AWS S3
- Backblaze B2
- Other S3-compatible providers (treated as "other")

Object encryption reporting varies by vendor. If the object metadata does not include encryption fields, the UI shows `None` for AWS S3 and Backblaze B2, and `Unknown` for other vendors to avoid false positives. This list is intended to grow as vendor-specific behavior is documented.

## Quick Install (Linux & macOS)

```bash
curl -sSL https://andrewtheguy.github.io/s3browser/install.sh | bash
```

To install a specific version:

```bash
curl -sSL https://andrewtheguy.github.io/s3browser/install.sh | bash -s v0.0.1
```

## Tech Stack

- **Frontend**: React, TypeScript, Tailwind CSS, Radix UI primitives, lucide-react icons
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

The password must be at least 16 characters. Environment variable takes precedence over file. The example command below generates a 44-character password.

```bash
# Option 1: Password file (recommended for persistence)
openssl rand -base64 32 > ~/.s3browser/login.password
chmod 600 ~/.s3browser/login.password

# Option 2: Environment variable (takes precedence if both are set)
export S3BROWSER_LOGIN_PASSWORD="your-password-here"
```

**Encryption Key** (required - encrypts saved S3 credentials at rest):

The encryption key must be at least 32 characters. Environment variable takes precedence over file.

```bash
# Option 1: Key file (recommended for persistence)
openssl rand -base64 32 > ~/.s3browser/encryption.key
chmod 600 ~/.s3browser/encryption.key

# Option 2: Environment variable (takes precedence if both are set)
export S3BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

**Optional TOML config** (`~/.s3browser/config.toml`):

Settings other than the encryption key can be put in a TOML file. Environment variables (and any `.env` Bun auto-loads) take precedence over values defined here. See `config.toml.example` for the template.

```toml
# ~/.s3browser/config.toml
S3BROWSER_LOGIN_PASSWORD = "your-16-plus-char-password"
S3BROWSER_PRESIGNED_URL_TTLS = "1h,1d"
S3BROWSER_SEARCH_WHITELIST_HOSTS = "minio.example.com,objstore.local"
```

The encryption key is intentionally excluded — keep it in `~/.s3browser/encryption.key` or the env var.

### Development

Start both the frontend and backend in development mode:

```bash
bun run dev
```

The frontend runs on `http://localhost:5173` and proxies API requests to the backend on `http://localhost:3001`.

To bind the dev backend to a different interface, set `HOST`. You can also set `PORT` to change the backend port:

```bash
HOST=0.0.0.0 PORT=3001 bun run dev:server
```

The Vite dev proxy is configured for backend port `3001`; if you run the backend on a different port, update `vite.config.ts` or call the backend directly.

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

The binary is a multi-command CLI:

```bash
./s3browser server                          # run the HTTP server
./s3browser server -b :8080                 # bind on all interfaces, port 8080
./s3browser server --bind 127.0.0.1:3000    # localhost only
./s3browser server --bind [::1]:3000        # IPv6 localhost
./s3browser index --connection 1            # crawl + index a saved S3 connection
./s3browser index --connection 1 --bucket my-bucket --batch-size 500
./s3browser index --reset                   # delete the search index DB
./s3browser --help                          # top-level help
./s3browser --version                       # version info
```

`./s3browser server` listens on all interfaces on port `8170` by default. Use `--bind 127.0.0.1:8170` for localhost-only access. Run `./s3browser server --help` or `./s3browser index --help` for subcommand-specific options.

### CLI (development)

During development, run the same subcommands without compiling via:

```bash
bun run cli server -b :3001
bun run cli index --connection 1
bun run cli index --reset
```

## Usage

### Login Flow

1. **Sign in** with your password (from `~/.s3browser/login.password` or environment variable)
2. **Enter a profile name and S3 credentials** (Access Key ID, Secret Access Key, endpoint)
3. **Select or enter a bucket** to browse
4. The connection profile is saved or updated when you connect

### Connecting to AWS S3

1. Sign in with your password
2. Enter a profile name, AWS Access Key ID, and Secret Access Key
3. Enter the bucket name (or leave empty to list available buckets)
4. Optionally check "Auto-detect region" or enter the region manually (e.g., `us-east-1`)

### Connecting to S3-Compatible Services

For MinIO, DigitalOcean Spaces, or other S3-compatible services:

1. Sign in with your password
2. Enter a profile name and access credentials
3. Enter the custom endpoint URL (e.g., `http://localhost:9000` for local MinIO)
4. Enter the bucket name
5. Enter the region if required by the service

### Saved Connections

Connections are saved as profiles when you connect:

1. Enter a profile name (1-64 characters; letters, numbers, dots, underscores, and hyphens only)
2. All credentials are saved (secret access key encrypted with AES-256-GCM)
3. Select a saved connection from the dropdown to quickly fill in credentials
4. Existing saved connections keep the stored secret key unless you choose to change it

## Data Storage

Persistent app data is stored in `~/.s3browser/`:

| File | Purpose |
|------|---------|
| `s3browser.db` | SQLite database (saved connections) |
| `encryption.key` | Encryption key for S3 credentials |
| `login.password` | Login password |
| `config.toml` | Optional TOML config (all settings except encryption key) |

SQLite may also create `s3browser.db-wal` and `s3browser.db-shm`. The standalone executable uses `s3browser.lock` while running to prevent multiple instances.

## Session Behavior

- Session expires after **4 hours of inactivity**
- Each authenticated request refreshes the session timer
- Active users stay logged in indefinitely
- To invalidate all sessions: change the login password and restart the server

## Limitations

| Action | Limit / behavior |
| --- | --- |
| Browse (list objects) | S3 returns keys and common prefixes in lexicographic order. The UI shows folders first and files second; by default each group is sorted by name, and the file group can also be sorted by size or last-modified time. Sorting is applied only within the current 5,000-item browse window (see examples below). |
| Upload | No item-count cap; constrained by browser file selection, per-file size limits, and concurrency. Max file size 5GB; files >= 10MB use multipart with 10MB parts (single uploads are for files < 10MB). Upload resume state is in memory and only works while the tab/session remains active. |
| Delete | No hard item cap overall in the UI flow; requests are chunked to at most 1,000 objects and about 90KB per request body. Large folder deletes prompt every 10,000 discovered objects while gathering the plan. |
| Copy / Move | No hard item cap overall in the UI flow; requests are chunked to at most 1,000 operations per request. Objects larger than 5GB are copied with multipart copy using 100MB parts. |
| Download | All file downloads — single, batch, and every preview type — stream through the authenticated server proxy (`/api/download/:connectionId/:bucket/object`). The browser never receives a direct S3 URL through normal browse/preview/download flows. Batch folder download additionally requires a browser with File System Access API support. |
| Copy Presigned URL | The "Copy Presigned URL" menu item is the one intentional exception to the proxy-only model: it returns an S3 presigned URL for the user to share. TTL must be between 60 seconds (application-level validation) and 7 days (AWS S3 presigned URL limit), default 1 hour if not provided. |
| Show Versions | Deleted folder detection (folders where all contents are deleted) only works accurately in the first 5,000-item window. Folders in subsequent windows may appear as live even if all their contents are deleted. |

### Browse window caveats (examples)

- Sorting happens within the current window only. A folder that falls into a later window won’t appear at the top until you switch to the window that includes it.
- Use the in-app “Load previous/next 5,000” controls to switch windows for larger folders.

**Example 1: Folder name pushes it to a later window**
- Suppose a prefix contains 6,000 items.
- The first 5,000 lexicographic keys are mostly files like `a-0001.txt` … `m-4999.txt`.
- A folder named `z-logs/` appears after those keys lexicographically, so it lands in the 5,001–6,000 window.
- In the first window, you won’t see `z-logs/` at the top, even though the UI sorts folders first—because it isn’t in that window yet.
- When you load the next 5,000 window, `z-logs/` will appear at the top of that window.

**Example 2: Mixed folders and files**
- If the first window includes folders `b-1/`, `b-2/` and files `a-1.txt`, `a-2.txt`, the UI will show `b-1/`, `b-2/` first, then `a-1.txt`, `a-2.txt` (folders are grouped before files within the window).
- If folders like `reports/` or `yearly/` fall into the next 5,000-item window, they won’t appear at all on the first window until you load that next window.

## Security

> **Important**: This application is intended for **private network** or **personal/trusted device** use only.

- Single-user authentication with password
- S3 secret access keys encrypted with AES-256-GCM at rest
- Encryption key required via environment variable or key file
- HTTP-only cookies with sliding 4-hour expiration
- Path traversal protection on all file operations
- Configuration files should be secured with 0600 permissions

**Data transmission**:
- Saved S3 secret keys are not returned to the client during normal browsing or connection selection
- Secret keys are only sent from client to server when creating a new connection or changing an existing key
- When using a saved connection, the secret key does not need to be re-entered (stored securely on server)
- To change a saved connection's secret key, enter a new value in the form
- Exporting an AWS or rclone profile intentionally decrypts the saved secret key server-side and sends it to the browser as a downloaded config file; only do this on trusted devices
- List, upload, delete, copy, move, metadata, and bucket-info operations are performed server-side
- All object access from the browser — single and batch downloads, plus text, image, video, audio, and PDF previews — flows through the authenticated `/api/download/:connectionId/:bucket/object` proxy. The proxy is the single S3-facing surface, so the browser never receives a direct S3 URL through normal browse/preview/download flows.
- The only intentional exception is the explicit "Copy Presigned URL" menu item, which returns a presigned URL for the user to share. Routing everything else through one proxy keeps every S3 request behind the same authentication, removes the need for any CORS configuration on the bucket, and prevents inconsistency where some UI affordances would expose S3 directly while others do not.

**Not recommended for**:
- Public internet deployment
- Multi-tenant environments
- Untrusted networks

## License

MIT
