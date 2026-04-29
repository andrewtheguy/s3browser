# Preview Security Measures

This document describes the current security controls used by the file preview flow.

## Scope

Preview functionality is implemented in:

- `src/hooks/usePreview.ts`
- `src/components/PreviewDialog/PreviewPanel.tsx`
- `src/components/PreviewDialog/PreviewBody.tsx`
- `src/components/PreviewDialog/TextPreview.tsx`
- `src/utils/previewUtils.ts`
- `server/routes/download.ts`

## Client-Side Controls

1. File type allowlisting
- Only known previewable types are allowed (`text`, `pdf`, `image`, `video`, `audio`).
- Unsupported types are blocked with a user-facing message instead of being rendered.

2. Risky text-like formats are handled as text
- Extensions such as `html`, `htm`, `xml`, and `csv` are classified as text previews.
- Text previews are fetched through the authenticated `/api/download/:connectionId/:bucket/object` proxy and rendered as text in the app instead of being loaded as browser documents.
- The MIME map keeps defensive `text/plain` entries for these extensions if they are ever requested through a signed preview URL, but the current text preview path does not depend on those overrides.

3. Text preview size limit
- Text previews are capped at 2 MiB.
- Larger text files are not rendered inline and must be downloaded.

4. Short-lived presigned URLs for preview
- PDF, image, video, and audio previews use presigned URLs with a client default of 1 hour (3600 s); the server accepts a configurable range of 60–604800 s (1 minute to 7 days).
- URLs are generated server-side; the client does not construct S3 signatures.

5. Rendering behavior by type
- Text previews render in-app as `<pre><code>` content, with optional syntax highlighting through `highlight.js`.
- Image, video, and audio previews render in `<iframe sandbox="">` with generated `srcDoc` (strict default sandbox model, no sandbox permissions granted).
- `pdf` preview does not use an iframe and opens in a new browser tab.
- Reason: Chrome blocks sandboxed PDF iframes ("This page has been blocked by Chrome"), so PDF preview is intentionally routed to a separate tab.
- Preview iframes and PDF links use `referrerPolicy="no-referrer"`.

6. DOM construction for generated `srcDoc`
- Media iframe previews are built using `DOMImplementation.createHTMLDocument` and serialized with `XMLSerializer`.
- Signed URLs and filenames are assigned via DOM property setters (e.g. `element.src`, `element.alt`), so the browser handles all necessary escaping implicitly.
- This prevents attribute/markup injection without relying on manual escape functions.

7. Request lifecycle safety
- In-flight preview requests are aborted when a new preview starts or dialog closes.
- Stale async responses are ignored via request-id checks.

## Server-Side Controls (`/api/download/:connectionId/:bucket/...`)

1. Authenticated S3 context required
- Routes run through `s3Middleware` and `requireBucket`.
- Requests without valid S3 context fail before signing or streaming.

2. Object key validation and traversal defense
- Rejects array/multi-value keys.
- Rejects missing keys.
- Rejects control characters and backslashes.
- Rejects absolute paths.
- Normalizes keys with `path.posix.normalize` and blocks traversal (`..`) and invalid normalized paths.

3. Version ID sanitization
- `versionId` is accepted only when it is a single safe string without unsafe characters.

4. TTL bounds enforced
- Applies to `/url`.
- Allowed presign TTL range: 60 seconds to 604800 seconds (7 days).
- Out-of-range or malformed values are rejected.

5. Content-Type validation for overrides
- Applies to `/url`.
- Optional `contentType` is validated for:
- no control chars
- basic MIME format compliance
- max length (256)

6. Content-Disposition safety
- Applies to `/url` and `/object`.
- For signed URLs, `inline` and `attachment` are supported.
- Attachment filename is sanitized to remove header-unsafe characters before inclusion.

7. Authenticated object proxy for text previews and batch downloads
- `/object` streams S3 objects through the authenticated server route.
- It applies the same object key validation and optional `versionId` sanitization.
- It returns `Content-Disposition: attachment` with a sanitized filename; browser `fetch` callers such as text preview read the response body directly.

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

4. In-app text rendering path
- Text previews rely on React text rendering for unhighlighted content and `highlight.js` output for highlighted content.
- Keep future syntax-highlighting changes constrained to escaping-safe libraries or explicit sanitization.

## Operational Recommendations

1. Keep preview TTLs short for high-sensitivity buckets.
2. Restrict preview permissions by role where possible.
3. Treat user-uploaded PDFs and media as untrusted content.
4. Consider additional audit logging for presigned URL generation in regulated environments.
