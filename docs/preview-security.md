# Preview Security Measures

This document describes the current security controls used by the file preview flow.

## Scope

Preview functionality is implemented in:

- `src/hooks/usePreview.ts`
- `src/components/PreviewDialog/PreviewDialog.tsx`
- `src/utils/previewUtils.ts`
- `server/routes/download.ts`

## Client-Side Controls

1. File type allowlisting
- Only known previewable types are allowed (`text`, `pdf`, `image`, `video`, `audio`).
- Unsupported types are blocked with a user-facing message instead of being rendered.

2. MIME type overrides for risky text-like formats
- The preview MIME map forces some extensions to safer values:
- `html`/`htm` -> `text/plain` (prevents rendering/executing markup in preview)
- `xml` -> `text/plain` (prevents inline XML rendering behavior)
- `csv` -> `text/plain` (avoids browser download/render inconsistencies)

3. Text preview size limit
- Text previews are capped at 2 MiB.
- Larger text files are not rendered inline and must be downloaded.

4. Short-lived presigned URLs for preview
- Preview requests use presigned URLs with a client default of 1 hour (3600 s); the server accepts a configurable range of 60–604800 s (1 minute to 7 days).
- URLs are generated server-side; the client does not construct S3 signatures.

5. Rendering behavior by type
- All non-PDF previews (`text`, `image`, `video`, and `audio`) render in `<iframe sandbox="">` (strict default sandbox model, no sandbox permissions granted).
- `pdf` preview does not use an iframe and opens in a new browser tab.
- Reason: Chrome blocks sandboxed PDF iframes ("This page has been blocked by Chrome"), so PDF preview is intentionally routed to a separate tab.
- Preview iframes use `referrerPolicy="no-referrer"`.

6. Escaping in generated `srcDoc`
- Media previews rendered through `srcDoc` escape HTML attribute-sensitive characters:
- `&`, `"`, `'`, `<`, `>`
- This prevents attribute/markup injection when embedding signed URLs and filenames.

7. Request lifecycle safety
- In-flight preview requests are aborted when a new preview starts or dialog closes.
- Stale async responses are ignored via request-id checks.

## Server-Side Controls (`/api/download/:connectionId/:bucket/url`)

1. Authenticated S3 context required
- Routes run through `s3Middleware` and `requireBucket`.
- Requests without valid S3 context fail before signing.

2. Object key validation and traversal defense
- Rejects array/multi-value keys.
- Rejects missing keys.
- Rejects control characters and backslashes.
- Rejects absolute paths.
- Normalizes keys with `path.posix.normalize` and blocks traversal (`..`) and invalid normalized paths.

3. Version ID sanitization
- `versionId` is accepted only when it is a single safe string without unsafe characters.

4. TTL bounds enforced
- Allowed presign TTL range: 60 seconds to 604800 seconds (7 days).
- Out-of-range or malformed values are rejected.

5. Content-Type validation for overrides
- Optional `contentType` is validated for:
- no control chars
- basic MIME format compliance
- max length (256)

6. Content-Disposition safety
- `inline` and `attachment` are supported.
- Attachment filename is sanitized to remove header-unsafe characters before inclusion.

## Known Residual Risks

1. Presigned URL bearer access
- Anyone with a valid presigned URL can access the object until URL expiry.
- Keep TTL short and avoid exposing URLs in logs or third-party channels.

2. Browser/PDF engine attack surface
- PDFs are opened in a separate tab, which reduces app-context coupling.
- The browser's PDF engine is still part of runtime attack surface for untrusted files.

3. Metadata correctness dependency
- Effective preview behavior can depend on object metadata and MIME overrides.
- If object metadata is misleading and no override is applied, browser behavior may vary.

## Operational Recommendations

1. Keep preview TTLs short for high-sensitivity buckets.
2. Restrict preview permissions by role where possible.
3. Treat user-uploaded PDFs and media as untrusted content.
4. Consider additional audit logging for presigned URL generation in regulated environments.
