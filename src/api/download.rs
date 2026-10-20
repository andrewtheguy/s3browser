//! `/api/download`: every object the browser reads streams through here, so
//! it never receives an S3 URL. The one exception is the explicit "Copy
//! Presigned URL" action (`/url`).

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use aws_sdk_s3::Client;
use aws_sdk_s3::operation::get_object::GetObjectOutput;
use aws_sdk_s3::presigning::PresigningConfig;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use log::{error, warn};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::io::ReaderStream;

use crate::crypto::{base64url, random_bytes};
use crate::error::AppError;
use crate::s3::ErrorInfo;
use crate::server::{ApiJson, ApiPath, ApiQuery, AppState, BucketPath};
use crate::session::now_secs;
use crate::validate::{
    MAX_KEY_BYTES, build_content_disposition, extract_file_name, has_unsafe_chars, sanitize_filename,
    sanitize_version_id, validate_content_type, validate_object_key,
};
use crate::zip::ZipWriter;

const STREAM_CHUNK_SIZE: usize = 64 * 1024;
/// Inline SVG is an image to `<img>`, but a script-capable document when
/// opened directly; this keeps it inert there.
const SVG_INLINE_CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
/// Folder downloads can far exceed the delete path's 1000-object cap.
const MAX_ZIP_ENTRIES: usize = 10_000;
const ZIP_TICKET_TTL: Duration = Duration::from_secs(5 * 60);
/// Bounds memory under repeated ticket creation.
const MAX_ZIP_TICKETS: usize = 256;
/// The archive path of the best-effort failure manifest; user entries may not
/// claim it.
const ERROR_MANIFEST_NAME: &str = "_download-errors.txt";
/// S3 drops long-lived connections mid-body on large batches. An entry's
/// header is already sent by then, so it is resumed with ranged GETs this many
/// times before being cut short and recorded in the manifest.
const MAX_MEMBER_RESUMES: usize = 3;
/// Archive chunks buffered between the S3 reader and a slow client.
const ZIP_CHANNEL_DEPTH: usize = 8;
const MIN_PRESIGN_TTL: u64 = 60;
const MAX_PRESIGN_TTL: u64 = 604_800;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/download/{connection_id}/{bucket}/url", get(presigned_url))
        .route("/api/download/{connection_id}/{bucket}/object", get(download_object))
        .route("/api/download/{connection_id}/{bucket}/batch-zip-ticket", post(create_batch_zip_ticket))
        .route("/api/download/{connection_id}/{bucket}/batch-zip", get(download_batch_zip))
}

#[derive(Clone, Debug)]
struct ZipEntry {
    key: String,
    version_id: Option<String>,
    name: String,
}

struct ZipTicket {
    connection_id: i64,
    bucket: String,
    entries: Vec<ZipEntry>,
    archive_name: String,
    expires_at: Instant,
}

/// Pending batch downloads. The browser posts the entry list (too long for a
/// URL) for a one-time ticket, then navigates to `batch-zip?ticket=…` so the
/// archive streams straight to its download manager.
#[derive(Default)]
pub struct ZipTickets {
    tickets: Mutex<HashMap<String, ZipTicket>>,
}

impl ZipTickets {
    fn prune(tickets: &mut HashMap<String, ZipTicket>, now: Instant) {
        tickets.retain(|_, ticket| ticket.expires_at > now);
        // Over quota, evict the tickets closest to expiry, leaving room for one more.
        while tickets.len() >= MAX_ZIP_TICKETS {
            let oldest = tickets
                .iter()
                .min_by_key(|(_, ticket)| ticket.expires_at)
                .map(|(token, _)| token.clone())
                .expect("non-empty");
            tickets.remove(&oldest);
        }
    }

    fn insert(&self, ticket: ZipTicket) -> String {
        let token = base64url(&random_bytes::<32>());
        let mut tickets = self.tickets.lock().unwrap();
        Self::prune(&mut tickets, Instant::now());
        tickets.insert(token.clone(), ticket);
        token
    }

    /// Redeem a ticket; it is gone afterwards either way.
    fn take(&self, token: &str) -> Option<ZipTicket> {
        let now = Instant::now();
        let mut tickets = self.tickets.lock().unwrap();
        Self::prune(&mut tickets, now);
        tickets.remove(token).filter(|ticket| ticket.expires_at > now)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObjectQuery {
    key: Option<String>,
    version_id: Option<String>,
    ttl: Option<String>,
    disposition: Option<String>,
    content_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZipEntryRequest {
    key: String,
    version_id: Option<String>,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchZipTicketRequest {
    entries: Option<Vec<ZipEntryRequest>>,
    archive_name: Option<String>,
}

#[derive(Deserialize)]
struct TicketQuery {
    ticket: Option<String>,
}

async fn presigned_url(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiQuery(query): ApiQuery<ObjectQuery>,
) -> Result<Json<Value>, AppError> {
    let key = validate_object_key(query.key.as_deref(), "Object key is required")?;
    let ttl = match query.ttl.as_deref() {
        None => 3600,
        Some(raw) => raw
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|ttl| (MIN_PRESIGN_TTL..=MAX_PRESIGN_TTL).contains(ttl))
            .ok_or_else(|| AppError::bad_request("TTL must be between 60 and 604800 seconds"))?,
    };
    let context = path.context(&state).await?;
    let filename = match extract_file_name(&key) {
        "" => "download",
        name => name,
    };
    let disposition = match query.disposition.as_deref() {
        Some("inline") => Some("inline".to_string()),
        Some("attachment") => Some(build_content_disposition("attachment", filename)),
        _ => None,
    };
    let presigning = PresigningConfig::expires_in(Duration::from_secs(ttl))
        .map_err(|e| AppError::failed("Failed to generate presigned URL", e))?;
    let request = context
        .client
        .get_object()
        .bucket(context.require_bucket()?)
        .key(&key)
        .set_version_id(sanitize_version_id(query.version_id.as_deref()))
        .set_response_content_disposition(disposition)
        .set_response_content_type(validate_content_type(query.content_type.as_deref()))
        .presigned(presigning)
        .await
        .map_err(|e| AppError::failed("Failed to generate presigned URL", ErrorInfo::of(&e)))?;
    Ok(Json(json!({ "url": request.uri() })))
}

/// Whether an object may be served inline on this origin: only the passive
/// types the previews render. Anything else (HTML, XML, scripts) could run
/// with the app's session, so it is only ever an attachment.
fn is_inline_safe(content_type: &str) -> bool {
    let mime = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    match mime.split_once('/') {
        Some(("image" | "video" | "audio", subtype)) => !subtype.is_empty(),
        _ => matches!(mime.as_str(), "application/pdf" | "text/plain"),
    }
}

fn is_svg(content_type: &str) -> bool {
    content_type.split(';').next().unwrap_or_default().trim().eq_ignore_ascii_case("image/svg+xml")
}

/// Stream one object, passing `Range` through so media seeking works.
async fn download_object(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiQuery(query): ApiQuery<ObjectQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let key = validate_object_key(query.key.as_deref(), "Object key is required")?;
    let context = path.context(&state).await?;
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let response = context
        .client
        .get_object()
        .bucket(context.require_bucket()?)
        .key(&key)
        .set_version_id(sanitize_version_id(query.version_id.as_deref()))
        .set_range(range)
        .send()
        .await
        .map_err(|e| {
            let info = ErrorInfo::of(&e);
            if info.is_access_denied() {
                AppError::forbidden("Access denied")
            } else if info.is_not_found() {
                AppError::not_found("Object not found")
            } else if info.status == Some(416) {
                AppError::status(StatusCode::RANGE_NOT_SATISFIABLE, "Range not satisfiable")
            } else {
                AppError::failed("Failed to stream object", info)
            }
        })?;

    let mut content_type = validate_content_type(query.content_type.as_deref())
        .or_else(|| response.content_type().filter(|t| !t.is_empty()).map(str::to_string))
        .filter(|t| HeaderValue::from_str(t).is_ok())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let inline = query.disposition.as_deref() == Some("inline") && is_inline_safe(&content_type);
    let disposition = if inline {
        "inline".to_string()
    } else {
        if query.disposition.as_deref() == Some("inline") {
            content_type = "application/octet-stream".to_string();
        }
        let filename = match extract_file_name(&key) {
            "" => "download",
            name => name,
        };
        build_content_disposition("attachment", filename)
    };
    let accept_ranges = response.accept_ranges().filter(|v| !v.is_empty()).unwrap_or("bytes");
    let mut out = HeaderMap::new();
    if inline && is_svg(&content_type) {
        out.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(SVG_INLINE_CSP));
    }
    out.insert(header::CONTENT_TYPE, HeaderValue::from_str(&content_type).map_err(anyhow::Error::from)?);
    out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    out.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).map_err(anyhow::Error::from)?,
    );
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_str(accept_ranges).map_err(anyhow::Error::from)?);
    if let Some(length) = response.content_length() {
        out.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    }
    let status = match response.content_range().filter(|r| !r.is_empty()) {
        Some(range) => {
            out.insert(header::CONTENT_RANGE, HeaderValue::from_str(range).map_err(anyhow::Error::from)?);
            StatusCode::PARTIAL_CONTENT
        }
        None => StatusCode::OK,
    };
    let body = Body::from_stream(ReaderStream::with_capacity(response.body.into_async_read(), STREAM_CHUNK_SIZE));
    Ok((status, out, body).into_response())
}

fn validate_zip_entry_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(AppError::bad_request("Archive entry name is required"));
    }
    if name.starts_with('/') {
        return Err(AppError::bad_request("Archive entry name must be relative"));
    }
    if name.split('/').any(|segment| matches!(segment, "" | "." | "..")) {
        return Err(AppError::bad_request("Invalid archive entry name"));
    }
    if has_unsafe_chars(name) {
        return Err(AppError::bad_request("Invalid character in archive entry name"));
    }
    if name == ERROR_MANIFEST_NAME {
        return Err(AppError::bad_request(format!("Reserved archive entry name: {name}")));
    }
    if name.len() > MAX_KEY_BYTES {
        return Err(AppError::bad_request("Archive entry name exceeds 1024 bytes"));
    }
    Ok(())
}

async fn create_batch_zip_ticket(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<BatchZipTicketRequest>,
) -> Result<Json<Value>, AppError> {
    let requested = body.entries.unwrap_or_default();
    if requested.is_empty() {
        return Err(AppError::bad_request("No objects to download"));
    }
    if requested.len() > MAX_ZIP_ENTRIES {
        return Err(AppError::bad_request(format!("Too many objects: limit is {MAX_ZIP_ENTRIES}")));
    }
    let mut names = std::collections::HashSet::new();
    let mut entries = Vec::with_capacity(requested.len());
    for entry in requested {
        let key = validate_object_key(Some(&entry.key), "Object key is required")?;
        validate_zip_entry_name(&entry.name)?;
        // Duplicate archive paths would make an ambiguous ZIP.
        if !names.insert(entry.name.clone()) {
            return Err(AppError::bad_request(format!("Duplicate archive entry name: {}", entry.name)));
        }
        entries.push(ZipEntry {
            key,
            version_id: sanitize_version_id(entry.version_id.as_deref()),
            name: entry.name,
        });
    }
    let mut archive_name = sanitize_filename(body.archive_name.as_deref().unwrap_or("download.zip"));
    if !archive_name.to_lowercase().ends_with(".zip") {
        archive_name.push_str(".zip");
    }
    let context = path.context(&state).await?;
    let token = state.zip_tickets.insert(ZipTicket {
        connection_id: context.connection.id,
        bucket: context.require_bucket()?.to_string(),
        entries,
        archive_name,
        expires_at: Instant::now() + ZIP_TICKET_TTL,
    });
    Ok(Json(json!({ "ticket": token })))
}

/// Stream the ticket's objects as one ZIP, fetched one at a time as the
/// client reads. Objects that cannot be fetched are listed in
/// `_download-errors.txt` at the end of the archive instead of failing it.
async fn download_batch_zip(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiQuery(query): ApiQuery<TicketQuery>,
) -> Result<Response, AppError> {
    let token = query
        .ticket
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::bad_request("Missing download ticket"))?;
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?.to_string();
    let ticket = state
        .zip_tickets
        .take(&token)
        .filter(|t| t.connection_id == context.connection.id && t.bucket == bucket)
        .ok_or_else(|| AppError::not_found("Download ticket not found or expired"))?;

    let (tx, mut rx) = mpsc::channel::<Bytes>(ZIP_CHANNEL_DEPTH);
    tokio::spawn(stream_zip(context.client, bucket, ticket.entries, tx));
    let stream = futures::stream::poll_fn(move |cx| rx.poll_recv(cx).map(|chunk| chunk.map(Ok::<_, Infallible>)));
    let disposition = build_content_disposition("attachment", &ticket.archive_name);
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("application/zip")),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_str(&disposition).map_err(anyhow::Error::from)?,
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            // Keep nginx from buffering the archive when deployed behind it.
            (header::HeaderName::from_static("x-accel-buffering"), HeaderValue::from_static("no")),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

async fn get_entry(
    client: &Client,
    bucket: &str,
    entry: &ZipEntry,
    offset: u64,
    if_match: Option<&str>,
) -> Result<GetObjectOutput, ErrorInfo> {
    client
        .get_object()
        .bucket(bucket)
        .key(&entry.key)
        .set_version_id(entry.version_id.clone())
        .set_range((offset > 0).then(|| format!("bytes={offset}-")))
        .set_if_match(if_match.map(str::to_string))
        .send()
        .await
        .map_err(|e| ErrorInfo::of(&e))
}

/// Writes the archive into `tx`; stops quietly once the client goes away.
async fn stream_zip(client: Client, bucket: String, entries: Vec<ZipEntry>, tx: mpsc::Sender<Bytes>) {
    let send = |bytes: Vec<u8>| {
        let tx = tx.clone();
        async move { bytes.is_empty() || tx.send(Bytes::from(bytes)).await.is_ok() }
    };
    let mut zip = ZipWriter::new();
    let mut errors: Vec<String> = Vec::new();
    for entry in &entries {
        let response = match get_entry(&client, &bucket, entry, 0, None).await {
            Ok(response) => response,
            Err(e) => {
                errors.push(format!("{}: {e}", entry.key));
                continue;
            }
        };
        let modified = response.last_modified().map_or_else(now_secs, |t| t.secs());
        // Refuse to resume if the object changes underneath: bytes from two
        // versions would silently corrupt the entry.
        let etag = response.e_tag().filter(|e| !e.is_empty()).map(str::to_string);
        if !send(zip.begin_entry(&entry.name, modified)).await {
            return;
        }
        let mut body = response.body;
        let mut offset: u64 = 0;
        let mut resumes = 0;
        loop {
            match body.next().await {
                None => break,
                Some(Ok(chunk)) => {
                    offset += chunk.len() as u64;
                    if !send(zip.write(&chunk)).await {
                        return;
                    }
                }
                Some(Err(e)) => {
                    resumes += 1;
                    if resumes > MAX_MEMBER_RESUMES {
                        errors.push(format!("{}: truncated at {offset} bytes: {e}", entry.name));
                        break;
                    }
                    warn!("Resuming zip entry {} at byte {offset}: {e}", entry.key);
                    match get_entry(&client, &bucket, entry, offset, etag.as_deref()).await {
                        Ok(resumed) => body = resumed.body,
                        Err(retry) => {
                            errors.push(format!("{}: truncated at {offset} bytes; resume failed: {retry}", entry.name));
                            break;
                        }
                    }
                }
            }
        }
        if !send(zip.end_entry()).await {
            return;
        }
    }
    if !errors.is_empty() {
        error!("Batch zip finished with {} failed object(s)", errors.len());
        let mut manifest = format!("{} object(s) could not be added to this archive:\n\n", errors.len());
        for line in &errors {
            manifest.push_str(&format!("- {line}\n"));
        }
        let mut out = zip.begin_entry(ERROR_MANIFEST_NAME, now_secs());
        out.extend(zip.write(manifest.as_bytes()));
        out.extend(zip.end_entry());
        if !send(out).await {
            return;
        }
    }
    send(zip.finish()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestApp;
    use aws_sdk_s3::operation::get_object::GetObjectError;
    use aws_sdk_s3::primitives::ByteStream;
    use aws_smithy_mocks::{RuleMode, mock, mock_client};
    use axum::http::Method;
    use http_body::Frame;
    use std::io::{Cursor, Read};

    const CONTENT_LEN: usize = 200_000;

    #[test]
    fn only_passive_types_are_served_inline() {
        for t in ["image/png", "IMAGE/JPEG", "image/svg+xml", "video/mp4", "audio/mpeg", "application/pdf", "text/plain; charset=utf-8"] {
            assert!(is_inline_safe(t), "{t}");
        }
        for t in ["text/html", "application/xhtml+xml", "text/xml", "application/javascript", "image/", "application/octet-stream"] {
            assert!(!is_inline_safe(t), "{t}");
        }
        assert!(is_svg("Image/SVG+XML; charset=utf-8") && !is_svg("image/png"));
    }

    fn content() -> Vec<u8> {
        (0..CONTENT_LEN).map(|i| (i % 251) as u8).collect()
    }

    /// A body of `data` in 64 KiB frames that fails after `fail_after` frames.
    fn body(data: Vec<u8>, fail_after: Option<usize>) -> ByteStream {
        let mut frames: Vec<Result<Frame<Bytes>, std::io::Error>> = data
            .chunks(STREAM_CHUNK_SIZE)
            .map(|c| Ok(Frame::data(Bytes::copy_from_slice(c))))
            .collect();
        if let Some(n) = fail_after {
            frames.truncate(n);
            frames.push(Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "connection dropped mid-body")));
        }
        ByteStream::from_body_1_x(http_body_util::StreamBody::new(futures::stream::iter(frames)))
    }

    fn output(data: Vec<u8>, fail_after: Option<usize>) -> GetObjectOutput {
        GetObjectOutput::builder().body(body(data, fail_after)).e_tag("\"abc123\"").build()
    }

    fn entry(key: &str, name: &str) -> ZipEntry {
        ZipEntry {
            key: key.to_string(),
            version_id: None,
            name: name.to_string(),
        }
    }

    async fn collect_zip(client: Client, entries: Vec<ZipEntry>) -> Vec<(String, Vec<u8>)> {
        let (tx, mut rx) = mpsc::channel(4);
        let writer = tokio::spawn(stream_zip(client, "example-bucket".into(), entries, tx));
        let mut bytes = Vec::new();
        while let Some(chunk) = rx.recv().await {
            bytes.extend_from_slice(&chunk);
        }
        writer.await.unwrap();
        let mut archive = ::zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut file = archive.by_index(i).unwrap();
                let mut data = Vec::new();
                file.read_to_end(&mut data).unwrap();
                (file.name().to_string(), data)
            })
            .collect()
    }

    #[tokio::test]
    async fn streams_objects_and_lists_failures_in_a_manifest() {
        let ok = mock!(Client::get_object)
            .match_requests(|r| r.bucket() == Some("example-bucket") && r.key() == Some("folder/file.txt") && r.range().is_none())
            .then_output(|| output(b"hello streaming zip".to_vec(), None));
        let missing = mock!(Client::get_object)
            .match_requests(|r| r.key() == Some("folder/gone.txt"))
            .then_error(|| {
                let meta = aws_sdk_s3::error::ErrorMetadata::builder()
                    .code("NoSuchKey")
                    .message("The specified key does not exist.")
                    .build();
                GetObjectError::NoSuchKey(aws_sdk_s3::types::error::NoSuchKey::builder().meta(meta).build())
            });
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, [&ok, &missing]);
        let files = collect_zip(client, vec![entry("folder/file.txt", "file.txt"), entry("folder/gone.txt", "gone.txt")]).await;
        assert_eq!(files[0], ("file.txt".to_string(), b"hello streaming zip".to_vec()));
        assert_eq!(files[1].0, ERROR_MANIFEST_NAME);
        let manifest = String::from_utf8(files[1].1.clone()).unwrap();
        assert!(manifest.starts_with("1 object(s) could not be added"), "{manifest}");
        assert!(manifest.contains("- folder/gone.txt: NoSuchKey"), "{manifest}");
    }

    #[tokio::test]
    async fn resumes_an_entry_with_a_ranged_get_after_a_mid_body_failure() {
        let first = mock!(Client::get_object)
            .match_requests(|r| r.range().is_none())
            .then_output(|| output(content(), Some(1)));
        let resume = mock!(Client::get_object)
            .match_requests(|r| r.range() == Some("bytes=65536-") && r.if_match() == Some("\"abc123\""))
            .then_output(|| output(content()[STREAM_CHUNK_SIZE..].to_vec(), None));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, [&first, &resume]);
        let files = collect_zip(client, vec![entry("folder/file.txt", "file.txt")]).await;
        assert_eq!(files, vec![("file.txt".to_string(), content())]);
        assert_eq!((first.num_calls(), resume.num_calls()), (1, 1));
    }

    #[tokio::test]
    async fn records_a_truncated_entry_when_resumes_are_exhausted() {
        let first = mock!(Client::get_object)
            .match_requests(|r| r.range().is_none())
            .then_output(|| output(content(), Some(1)));
        let resume = mock!(Client::get_object)
            .match_requests(|r| r.range() == Some("bytes=65536-"))
            .then_output(|| output(content()[STREAM_CHUNK_SIZE..].to_vec(), Some(0)));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, [&first, &resume]);
        let files = collect_zip(client, vec![entry("folder/file.txt", "file.txt")]).await;
        assert_eq!(resume.num_calls(), MAX_MEMBER_RESUMES);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0], ("file.txt".to_string(), content()[..STREAM_CHUNK_SIZE].to_vec()));
        let manifest = String::from_utf8(files[1].1.clone()).unwrap();
        assert!(manifest.contains("file.txt: truncated at 65536 bytes"), "{manifest}");
    }

    #[test]
    fn entry_names() {
        for ok in ["a.txt", "dir/sub/b.txt", "..hidden/x"] {
            assert!(validate_zip_entry_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "/abs", "a//b", "a/./b", "../x", "a\\b", "a\tb", ERROR_MANIFEST_NAME] {
            assert!(validate_zip_entry_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_zip_entry_name(&"x".repeat(1025)).is_err());
    }

    #[test]
    fn tickets_are_single_use_and_bounded() {
        let tickets = ZipTickets::default();
        let ticket = |expires_at| ZipTicket {
            connection_id: 1,
            bucket: "b".into(),
            entries: vec![],
            archive_name: "a.zip".into(),
            expires_at,
        };
        let token = tickets.insert(ticket(Instant::now() + ZIP_TICKET_TTL));
        assert_eq!(token.len(), 43);
        assert!(tickets.take(&token).is_some());
        assert!(tickets.take(&token).is_none());
        let expired = tickets.insert(ticket(Instant::now()));
        assert!(tickets.take(&expired).is_none());
        for _ in 0..MAX_ZIP_TICKETS + 10 {
            tickets.insert(ticket(Instant::now() + ZIP_TICKET_TTL));
        }
        assert_eq!(tickets.tickets.lock().unwrap().len(), MAX_ZIP_TICKETS);
    }

    #[tokio::test]
    async fn ticket_requests_are_validated() {
        let app = TestApp::new().await;
        let saved = app.save_connection("local", "http://127.0.0.1:9").await;
        let url = format!("/api/download/{}/b/batch-zip-ticket", saved.id);
        let cases = [
            (json!({ "entries": [] }), "No objects to download"),
            (json!({ "entries": [{ "key": "/a", "name": "a" }] }), "Absolute paths not allowed"),
            (
                json!({ "entries": [{ "key": "a", "name": "x" }, { "key": "b", "name": "x" }] }),
                "Duplicate archive entry name: x",
            ),
        ];
        for (body, error) in cases {
            let (status, response) = app.authed(Method::POST, &url, Some(body)).await;
            assert_eq!((status, response), (StatusCode::BAD_REQUEST, json!({ "error": error })));
        }

        let (status, response) = app
            .authed(Method::POST, &url, Some(json!({ "entries": [{ "key": "a", "name": "a" }], "archiveName": "Folder" })))
            .await;
        assert_eq!(status, StatusCode::OK);
        let ticket = response["ticket"].as_str().unwrap();
        let (status, response) = app
            .authed(Method::GET, &format!("/api/download/{}/other/batch-zip?ticket={ticket}", saved.id), None)
            .await;
        assert_eq!(
            (status, response),
            (StatusCode::NOT_FOUND, json!({ "error": "Download ticket not found or expired" })),
            "a ticket only works for its own bucket, and is used up by the attempt"
        );
        let (status, _) = app
            .authed(Method::GET, &format!("/api/download/{}/b/batch-zip?ticket={ticket}", saved.id), None)
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
