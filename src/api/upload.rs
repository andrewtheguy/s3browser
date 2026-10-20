//! `/api/upload`: browser uploads proxied to S3. Files under 10 MiB go up in
//! one request; larger ones as a multipart upload of 10 MiB parts that the
//! browser sends one request each, so a failed part can be retried alone.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::post;
use axum::{Json, Router};
use log::error;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::AppError;
use crate::s3::ErrorInfo;
use crate::server::{ApiBytes, ApiJson, ApiPath, ApiQuery, AppState, BucketPath};
use crate::validate::validate_object_key;

const PART_SIZE: i64 = 10 * 1024 * 1024;
const MAX_FILE_SIZE: i64 = 5 * 1024 * 1024 * 1024;
/// Largest body for a single upload or one part.
const MAX_BODY: usize = PART_SIZE as usize;
/// Uploads never completed or aborted are forgotten after a day.
const TRACKING_TTL: Duration = Duration::from_secs(24 * 60 * 60);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/upload/{connection_id}/{bucket}/single", post(upload_single))
        .route("/api/upload/{connection_id}/{bucket}/initiate", post(initiate_upload))
        .route("/api/upload/{connection_id}/{bucket}/part", post(upload_part))
        .route("/api/upload/{connection_id}/{bucket}/complete", post(complete_upload))
        .route("/api/upload/{connection_id}/{bucket}/abort", post(abort_upload))
}

struct Tracked {
    key: String,
    total_parts: i64,
    created_at: Instant,
}

/// Multipart uploads this server started, so parts and completion can only
/// target the key and part range that were initiated.
#[derive(Default)]
pub struct UploadTracker {
    uploads: Mutex<HashMap<String, Tracked>>,
}

impl UploadTracker {
    fn tracking_key(connection_id: i64, bucket: &str, upload_id: &str) -> String {
        format!("{connection_id}:{bucket}:{upload_id}")
    }

    fn insert(&self, id: String, tracked: Tracked) {
        let mut uploads = self.uploads.lock().unwrap();
        uploads.retain(|_, t| t.created_at.elapsed() <= TRACKING_TTL);
        uploads.insert(id, tracked);
    }

    /// The tracked key and part count.
    fn get(&self, id: &str) -> Option<(String, i64)> {
        self.uploads.lock().unwrap().get(id).map(|t| (t.key.clone(), t.total_parts))
    }

    fn remove(&self, id: &str) {
        self.uploads.lock().unwrap().remove(id);
    }
}

#[derive(Deserialize)]
struct KeyQuery {
    key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartQuery {
    upload_id: Option<String>,
    key: Option<String>,
    part_number: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitiateUploadBody {
    key: Option<String>,
    content_type: Option<String>,
    file_size: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletePart {
    part_number: i32,
    etag: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteUploadBody {
    upload_id: Option<String>,
    key: Option<String>,
    parts: Option<Vec<CompletePart>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbortUploadBody {
    upload_id: Option<String>,
    key: Option<String>,
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

fn check_body_size(body: &[u8]) -> Result<(), AppError> {
    if body.len() > MAX_BODY {
        return Err(AppError::status(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"));
    }
    Ok(())
}

async fn upload_single(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiQuery(query): ApiQuery<KeyQuery>,
    headers: HeaderMap,
    ApiBytes(body): ApiBytes,
) -> Result<Json<Value>, AppError> {
    let key = validate_object_key(query.key.as_deref(), "Key query parameter is required")?;
    check_body_size(&body)?;
    let context = path.context(&state).await?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .unwrap_or("application/octet-stream");
    context
        .client
        .put_object()
        .bucket(context.require_bucket()?)
        .key(&key)
        .body(ByteStream::from(body))
        .content_type(content_type)
        .send()
        .await
        .map_err(|e| AppError::failed("Single file upload failed", ErrorInfo::of(&e)))?;
    Ok(Json(json!({ "success": true, "key": key })))
}

async fn initiate_upload(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<InitiateUploadBody>,
) -> Result<Json<Value>, AppError> {
    if non_empty(&body.key).is_none() {
        return Err(AppError::bad_request("Key is required"));
    }
    let file_size = body
        .file_size
        .filter(|s| *s > 0)
        .ok_or_else(|| AppError::bad_request("Valid fileSize is required"))?;
    if file_size > MAX_FILE_SIZE {
        return Err(AppError::bad_request(format!(
            "File size exceeds maximum of {MAX_FILE_SIZE} bytes"
        )));
    }
    let key = validate_object_key(body.key.as_deref(), "Key is required")?;
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let failed = |cause: &dyn std::fmt::Display| AppError::failed("Failed to initiate multipart upload", cause);
    let response = context
        .client
        .create_multipart_upload()
        .bucket(bucket)
        .key(&key)
        .content_type(non_empty(&body.content_type).unwrap_or("application/octet-stream"))
        .send()
        .await
        .map_err(|e| failed(&ErrorInfo::of(&e)))?;
    let upload_id = response
        .upload_id()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| failed(&"no UploadId in the response"))?;
    let total_parts = (file_size + PART_SIZE - 1) / PART_SIZE;
    state.uploads.insert(
        UploadTracker::tracking_key(context.connection.id, bucket, upload_id),
        Tracked {
            key: key.clone(),
            total_parts,
            created_at: Instant::now(),
        },
    );
    Ok(Json(json!({
        "uploadId": upload_id,
        "key": key,
        "totalParts": total_parts,
        "partSize": PART_SIZE,
    })))
}

async fn upload_part(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiQuery(query): ApiQuery<PartQuery>,
    ApiBytes(body): ApiBytes,
) -> Result<Json<Value>, AppError> {
    let upload_id =
        non_empty(&query.upload_id).ok_or_else(|| AppError::bad_request("uploadId query parameter is required"))?;
    let part_number = query
        .part_number
        .as_deref()
        .filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|p| p.parse::<i32>().ok())
        .filter(|p| *p >= 1)
        .ok_or_else(|| AppError::bad_request("Valid partNumber query parameter (>= 1) is required"))?;
    let key = non_empty(&query.key).ok_or_else(|| AppError::bad_request("key query parameter is required"))?;
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let (tracked_key, total_parts) = state
        .uploads
        .get(&UploadTracker::tracking_key(context.connection.id, bucket, upload_id))
        .ok_or_else(|| AppError::not_found("Upload not found or expired"))?;
    if key != tracked_key {
        return Err(AppError::forbidden("Key does not match the upload"));
    }
    if i64::from(part_number) > total_parts {
        return Err(AppError::bad_request(format!(
            "Part number {part_number} exceeds total parts {total_parts}"
        )));
    }
    check_body_size(&body)?;
    let response = context
        .client
        .upload_part()
        .bucket(bucket)
        .key(&tracked_key)
        .upload_id(upload_id)
        .part_number(part_number)
        .body(ByteStream::from(body))
        .send()
        .await
        .map_err(|e| AppError::failed("Upload part failed", ErrorInfo::of(&e)))?;
    Ok(Json(json!({ "etag": response.e_tag() })))
}

async fn complete_upload(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<CompleteUploadBody>,
) -> Result<Json<Value>, AppError> {
    let upload_id = non_empty(&body.upload_id).ok_or_else(|| AppError::bad_request("uploadId is required"))?;
    let key = non_empty(&body.key).ok_or_else(|| AppError::bad_request("Key is required"))?;
    let mut parts = body
        .parts
        .filter(|p| !p.is_empty())
        .ok_or_else(|| AppError::bad_request("Parts array is required"))?;
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let tracking_key = UploadTracker::tracking_key(context.connection.id, bucket, upload_id);
    let (tracked_key, _) = state
        .uploads
        .get(&tracking_key)
        .ok_or_else(|| AppError::not_found("Upload not found or expired"))?;
    if key != tracked_key {
        return Err(AppError::forbidden("Key does not match the upload"));
    }
    parts.sort_by_key(|p| p.part_number);
    let completed = CompletedMultipartUpload::builder()
        .set_parts(Some(
            parts
                .into_iter()
                .map(|p| CompletedPart::builder().part_number(p.part_number).e_tag(p.etag).build())
                .collect(),
        ))
        .build();
    let result = context
        .client
        .complete_multipart_upload()
        .bucket(bucket)
        .key(&tracked_key)
        .upload_id(upload_id)
        .multipart_upload(completed)
        .send()
        .await;
    state.uploads.remove(&tracking_key);
    if let Err(e) = result {
        if let Err(abort) = context
            .client
            .abort_multipart_upload()
            .bucket(bucket)
            .key(&tracked_key)
            .upload_id(upload_id)
            .send()
            .await
        {
            error!(
                "Failed to abort multipart upload after completion failure: {}",
                ErrorInfo::of(&abort)
            );
        }
        return Err(AppError::failed("Failed to complete multipart upload", ErrorInfo::of(&e)));
    }
    Ok(Json(json!({ "success": true, "key": tracked_key })))
}

async fn abort_upload(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<AbortUploadBody>,
) -> Result<Json<Value>, AppError> {
    let upload_id = non_empty(&body.upload_id).ok_or_else(|| AppError::bad_request("uploadId is required"))?;
    if non_empty(&body.key).is_none() {
        return Err(AppError::bad_request("Key is required"));
    }
    let key = validate_object_key(body.key.as_deref(), "Key is required")?;
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let tracking_key = UploadTracker::tracking_key(context.connection.id, bucket, upload_id);
    if let Some((tracked_key, _)) = state.uploads.get(&tracking_key)
        && key != tracked_key
    {
        return Err(AppError::bad_request("Key does not match the upload"));
    }
    let result = context
        .client
        .abort_multipart_upload()
        .bucket(bucket)
        .key(&key)
        .upload_id(upload_id)
        .send()
        .await;
    state.uploads.remove(&tracking_key);
    result.map_err(|e| AppError::failed("Failed to abort multipart upload", ErrorInfo::of(&e)))?;
    Ok(Json(json!({ "success": true })))
}
