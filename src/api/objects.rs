//! `/api/objects`: listing, search, delete, folders, copy/move and metadata.

use aws_sdk_s3::Client;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{ChecksumMode, CompletedMultipartUpload, CompletedPart, Delete, ObjectIdentifier};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{StreamExt, TryStreamExt};
use log::error;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::SEARCH_WHITELIST_ENV_VAR;
use crate::db::{SearchParams, SearchSort};
use crate::error::AppError;
use crate::s3::{ErrorInfo, S3Context, S3ResultExt, detect_vendor};
use crate::server::{ApiJson, ApiPath, ApiQuery, AppState, BucketPath};
use crate::validate::{
    decode_version_token, encode_version_token, epoch_iso, extract_file_name, iso_z, quote, sanitize_folder_path,
    sanitize_version_id, validate_copy_key, validate_object_key,
};

const MAX_BATCH_OPERATIONS: usize = 1000;
const LIST_PAGE_SIZE: i32 = 1000;
const TEST_SEED_COUNT: usize = 10005;
const TEST_SEED_CONCURRENCY: usize = 25;
/// CopyObject's own limit; larger objects are copied part by part.
const MULTIPART_COPY_THRESHOLD: i64 = 5 * 1024 * 1024 * 1024;
const COPY_PART_SIZE: i64 = 100 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/objects/{connection_id}/{bucket}", get(list_objects).delete(delete_object))
        .route("/api/objects/{connection_id}/{bucket}/index-status", get(index_status))
        .route("/api/objects/{connection_id}/{bucket}/search", get(search_objects))
        .route("/api/objects/{connection_id}/{bucket}/seed-test-items", post(seed_test_items))
        .route("/api/objects/{connection_id}/{bucket}/batch-delete", post(batch_delete))
        .route("/api/objects/{connection_id}/{bucket}/folder", post(create_folder))
        .route("/api/objects/{connection_id}/{bucket}/copy", post(copy_object))
        .route("/api/objects/{connection_id}/{bucket}/batch-copy", post(batch_copy))
        .route("/api/objects/{connection_id}/{bucket}/move", post(move_object))
        .route("/api/objects/{connection_id}/{bucket}/batch-move", post(batch_move))
        .route("/api/objects/{connection_id}/{bucket}/metadata", get(object_metadata))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectItem {
    key: String,
    name: String,
    is_folder: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_latest: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_delete_marker: Option<bool>,
}

impl ObjectItem {
    fn new(key: &str, is_folder: bool) -> Self {
        Self {
            key: key.to_string(),
            name: extract_file_name(key).to_string(),
            is_folder,
            size: None,
            last_modified: None,
            etag: None,
            version_id: None,
            is_latest: None,
            is_delete_marker: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    prefix: Option<String>,
    continuation_token: Option<String>,
    versions: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyQuery {
    key: Option<String>,
    version_id: Option<String>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
    sort: Option<String>,
    dir: Option<String>,
    ext: Option<String>,
    prefix: Option<String>,
}

#[derive(Deserialize)]
struct FolderRequest {
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteEntry {
    key: Option<String>,
    version_id: Option<String>,
}

#[derive(Deserialize)]
struct BatchDeleteRequest {
    keys: Option<Vec<DeleteEntry>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyRequest {
    source_key: Option<String>,
    destination_key: Option<String>,
    version_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyOperation {
    source_key: String,
    destination_key: String,
    version_id: Option<String>,
}

#[derive(Deserialize)]
struct BatchCopyRequest {
    operations: Option<Vec<CopyOperation>>,
}

#[derive(Deserialize)]
struct SeedTestItemsRequest {
    prefix: Option<String>,
}

fn is_versioning_not_supported(info: &ErrorInfo) -> bool {
    let text = info.to_string().to_lowercase();
    info.code_is(&["NotImplemented"])
        || info.status == Some(501)
        || text.contains("notimplemented")
        || text.contains("not implemented")
}

fn list_failed(info: ErrorInfo, what: &str) -> AppError {
    if info.is_access_denied() {
        return AppError::forbidden("Access denied");
    }
    error!("Failed to {what}: {info}");
    AppError::status(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// One page (up to 1000) of folders and files directly under `prefix`, or of
/// versions and delete markers with `versions=1`.
async fn list_objects(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiQuery(query): ApiQuery<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let prefix = query.prefix.unwrap_or_default();
    let mut objects = Vec::new();

    if query.versions.as_deref() == Some("1") {
        let markers = decode_version_token(query.continuation_token.as_deref());
        let response = context
            .client
            .list_object_versions()
            .bucket(bucket)
            .prefix(&prefix)
            .delimiter("/")
            .max_keys(LIST_PAGE_SIZE)
            .set_key_marker(markers.key_marker.filter(|m| !m.is_empty()))
            .set_version_id_marker(markers.version_id_marker.filter(|m| !m.is_empty()))
            .send()
            .await
            .map_err(|e| {
                let info = ErrorInfo::of(&e);
                if !info.is_access_denied() && is_versioning_not_supported(&info) {
                    AppError::coded(StatusCode::NOT_IMPLEMENTED, "Versioning not supported", "NotImplemented")
                } else {
                    list_failed(info, "list object versions")
                }
            })?;
        for common in response.common_prefixes() {
            if let Some(key) = common.prefix().filter(|k| !k.is_empty()) {
                objects.push(ObjectItem::new(key, true));
            }
        }
        for version in response.versions() {
            let Some(key) = version.key().filter(|k| !k.is_empty() && *k != prefix) else {
                continue;
            };
            objects.push(ObjectItem {
                size: version.size(),
                last_modified: version.last_modified().and_then(iso_z),
                etag: version.e_tag().map(str::to_string),
                version_id: version.version_id().map(str::to_string),
                is_latest: version.is_latest(),
                ..ObjectItem::new(key, false)
            });
        }
        for marker in response.delete_markers() {
            let Some(key) = marker.key().filter(|k| !k.is_empty() && *k != prefix) else {
                continue;
            };
            objects.push(ObjectItem {
                last_modified: marker.last_modified().and_then(iso_z),
                version_id: marker.version_id().map(str::to_string),
                is_latest: marker.is_latest(),
                is_delete_marker: Some(true),
                ..ObjectItem::new(key, key.ends_with('/'))
            });
        }
        return Ok(Json(json!({
            "objects": objects,
            "continuationToken": encode_version_token(response.next_key_marker(), response.next_version_id_marker()),
            "isTruncated": response.is_truncated().unwrap_or(false),
        })));
    }

    let response = context
        .client
        .list_objects_v2()
        .bucket(bucket)
        .prefix(&prefix)
        .delimiter("/")
        .max_keys(LIST_PAGE_SIZE)
        .set_continuation_token(query.continuation_token.filter(|t| !t.is_empty()))
        .send()
        .await
        .map_err(|e| list_failed(ErrorInfo::of(&e), "list objects"))?;
    for common in response.common_prefixes() {
        if let Some(key) = common.prefix().filter(|k| !k.is_empty()) {
            objects.push(ObjectItem::new(key, true));
        }
    }
    for object in response.contents() {
        let Some(key) = object.key().filter(|k| !k.is_empty() && *k != prefix) else {
            continue;
        };
        objects.push(ObjectItem {
            size: object.size(),
            last_modified: object.last_modified().and_then(iso_z),
            etag: object.e_tag().map(str::to_string),
            ..ObjectItem::new(key, false)
        });
    }
    Ok(Json(json!({
        "objects": objects,
        "continuationToken": response.next_continuation_token(),
        "isTruncated": response.is_truncated().unwrap_or(false),
    })))
}

/// The connection's endpoint host if search is enabled for it.
fn search_host(state: &AppState, context: &S3Context) -> Result<String, AppError> {
    state.search_host(Some(&context.connection.endpoint)).ok_or_else(|| {
        AppError::coded(
            StatusCode::FORBIDDEN,
            format!("Search disabled: this connection's endpoint host is not in {SEARCH_WHITELIST_ENV_VAR}."),
            "EndpointNotWhitelisted",
        )
    })
}

async fn index_status(State(state): State<AppState>, ApiPath(path): ApiPath<BucketPath>) -> Result<Json<Value>, AppError> {
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let host = search_host(&state, &context)?;
    let status = state.index_db.status(&host, bucket).await?;
    Ok(Json(match status {
        Some(status) if status.last_completed_at.is_some() => json!({
            "lastIndexedAt": status.last_completed_at.and_then(epoch_iso),
            "objectCount": status.object_count,
        }),
        _ => json!({ "lastIndexedAt": null, "objectCount": null }),
    }))
}

/// `limit` in 1..=500 (default 100), `offset` >= 0 (default 0); unparseable
/// values fall back to the defaults.
fn limit_offset(limit: Option<&str>, offset: Option<&str>) -> (i64, i64) {
    let limit = limit.and_then(|l| l.trim().parse::<i64>().ok()).unwrap_or(100);
    let offset = offset.and_then(|o| o.trim().parse::<i64>().ok()).unwrap_or(0);
    (if limit > 0 { limit.min(500) } else { 100 }, offset.max(0))
}

async fn search_objects(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiQuery(query): ApiQuery<SearchQuery>,
) -> Result<Json<Value>, AppError> {
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let q = query.q.as_deref().unwrap_or_default().trim();
    if q.is_empty() {
        return Err(AppError::bad_request("Search query is required"));
    }
    let host = search_host(&state, &context)?;
    let Some(status) = state.index_db.status(&host, bucket).await?.filter(|s| s.last_completed_at.is_some()) else {
        return Err(AppError::coded(
            StatusCode::NOT_FOUND,
            format!(
                "Index not built. Run: s3browser index --connection {} --bucket {bucket}",
                context.connection.id
            ),
            "IndexNotBuilt",
        ));
    };
    let (limit, offset) = limit_offset(query.limit.as_deref(), query.offset.as_deref());
    let extension = query.ext.as_deref().unwrap_or_default().trim().trim_start_matches('.');
    let params = SearchParams {
        query: q,
        limit,
        offset,
        sort: if query.sort.as_deref() == Some("last_modified") { SearchSort::LastModified } else { SearchSort::Key },
        descending: query.dir.as_deref() == Some("desc"),
        prefix: query.prefix.as_deref().unwrap_or_default(),
        extension,
    };
    let (hits, total) = state.index_db.search(status.id, &params).await?;
    let objects: Vec<Value> = hits
        .into_iter()
        .map(|hit| {
            json!({
                "name": extract_file_name(&hit.key),
                "isFolder": hit.key.ends_with('/'),
                "key": hit.key,
                "size": hit.size,
                "lastModified": epoch_iso(hit.last_modified),
                "contentSnippet": hit.content_snippet,
                "contentMatchCount": hit.content_match_count,
            })
        })
        .collect();
    Ok(Json(json!({
        "objects": objects,
        "total": total,
        "lastIndexedAt": status.last_completed_at.and_then(epoch_iso),
        "objectCount": status.object_count,
    })))
}

/// Development aid behind `FEATURE_SEED_TEST_ITEMS`: 10,005 empty objects
/// under a prefix, for exercising the 5,000-item browse windows.
async fn seed_test_items(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<SeedTestItemsRequest>,
) -> Result<Json<Value>, AppError> {
    if !state.seed_test_items {
        return Err(AppError::not_found("Not found"));
    }
    let raw_prefix = body
        .prefix
        .as_deref()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| AppError::bad_request("Prefix is required"))?;
    let prefix = sanitize_folder_path(Some(raw_prefix))?;
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let width = TEST_SEED_COUNT.to_string().len();
    futures::stream::iter(1..=TEST_SEED_COUNT)
        .map(|index| {
            context
                .client
                .put_object()
                .bucket(bucket)
                .key(format!("{prefix}item-{index:0width$}.txt"))
                .body(ByteStream::from_static(b""))
                .content_type("text/plain")
                .send()
        })
        .buffer_unordered(TEST_SEED_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await
        .s3_context("PutObject")?;
    Ok(Json(json!({ "created": TEST_SEED_COUNT, "prefix": prefix })))
}

async fn delete_object(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiQuery(query): ApiQuery<KeyQuery>,
) -> Result<Json<Value>, AppError> {
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let key = validate_object_key(query.key.as_deref(), "Object key is required")?;
    context
        .client
        .delete_object()
        .bucket(bucket)
        .key(key)
        .set_version_id(sanitize_version_id(query.version_id.as_deref()))
        .send()
        .await
        .s3_context("DeleteObject")?;
    Ok(Json(json!({ "success": true })))
}

/// Up to 1000 files (or specific versions) in one DeleteObjects call. Keys are
/// used exactly as sent (S3 keys may start or end with spaces); folder keys
/// are skipped unless a version is named.
async fn batch_delete(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<BatchDeleteRequest>,
) -> Result<Json<Value>, AppError> {
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let entries = body
        .keys
        .filter(|k| !k.is_empty())
        .ok_or_else(|| AppError::bad_request("Keys must be a non-empty array"))?;
    let objects: Vec<ObjectIdentifier> = entries
        .iter()
        .filter_map(|entry| {
            let key = entry.key.as_deref()?;
            let version_id = sanitize_version_id(entry.version_id.as_deref());
            if key.is_empty() || (key.ends_with('/') && version_id.is_none()) {
                return None;
            }
            ObjectIdentifier::builder().key(key).set_version_id(version_id).build().ok()
        })
        .collect();
    if objects.is_empty() {
        return Err(AppError::bad_request("No valid file keys provided"));
    }
    if objects.len() > MAX_BATCH_OPERATIONS {
        return Err(AppError::bad_request(format!(
            "Cannot delete more than {MAX_BATCH_OPERATIONS} objects at once"
        )));
    }
    let delete = Delete::builder()
        .set_objects(Some(objects))
        .quiet(false)
        .build()
        .map_err(anyhow::Error::from)?;
    let response = context
        .client
        .delete_objects()
        .bucket(bucket)
        .delete(delete)
        .send()
        .await
        .s3_context("DeleteObjects")?;
    let deleted: Vec<Value> = response
        .deleted()
        .iter()
        .filter_map(|item| {
            let key = item.key().filter(|k| !k.is_empty())?;
            let mut out = json!({ "key": key });
            if let Some(version) = item.version_id().or(item.delete_marker_version_id()).filter(|v| !v.is_empty()) {
                out["versionId"] = json!(version);
            }
            Some(out)
        })
        .collect();
    let errors: Vec<Value> = response
        .errors()
        .iter()
        .filter_map(|item| {
            let key = item.key().filter(|k| !k.is_empty())?;
            Some(json!({ "key": key, "message": item.message().filter(|m| !m.is_empty()).unwrap_or("Unknown error") }))
        })
        .collect();
    Ok(Json(json!({ "deleted": deleted, "errors": errors })))
}

async fn create_folder(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<FolderRequest>,
) -> Result<Json<Value>, AppError> {
    let folder = sanitize_folder_path(body.path.as_deref())?;
    let context = path.context(&state).await?;
    context
        .client
        .put_object()
        .bucket(context.require_bucket()?)
        .key(&folder)
        .body(ByteStream::from_static(b""))
        .content_type("application/x-directory")
        .send()
        .await
        .s3_context("PutObject")?;
    Ok(Json(json!({ "success": true, "key": folder })))
}

/// The `x-amz-copy-source` value: URL-encoded `bucket/key[?versionId=…]`.
fn copy_source(bucket: &str, key: &str, version_id: Option<&str>) -> String {
    let source = quote(&format!("{bucket}/{key}"), "/");
    match version_id {
        Some(version_id) => format!("{source}?versionId={}", quote(version_id, "")),
        None => source,
    }
}

async fn copy_multipart(
    client: &Client,
    bucket: &str,
    source_key: &str,
    destination_key: &str,
    size: i64,
    version_id: Option<&str>,
    head: &aws_sdk_s3::operation::head_object::HeadObjectOutput,
) -> anyhow::Result<()> {
    let created = client
        .create_multipart_upload()
        .bucket(bucket)
        .key(destination_key)
        .set_content_type(head.content_type().map(str::to_string))
        .set_metadata(head.metadata().cloned())
        .send()
        .await
        .s3_context("CreateMultipartUpload")?;
    let upload_id = created
        .upload_id()
        .ok_or_else(|| anyhow::anyhow!("Failed to initiate multipart upload"))?
        .to_string();
    let source = copy_source(bucket, source_key, version_id);
    let copy_parts = async {
        let mut parts = Vec::new();
        let total_parts = (size + COPY_PART_SIZE - 1) / COPY_PART_SIZE;
        for part_number in 1..=total_parts {
            let start = (part_number - 1) * COPY_PART_SIZE;
            let end = (part_number * COPY_PART_SIZE - 1).min(size - 1);
            let response = client
                .upload_part_copy()
                .bucket(bucket)
                .key(destination_key)
                .copy_source(&source)
                .upload_id(&upload_id)
                .part_number(part_number as i32)
                .copy_source_range(format!("bytes={start}-{end}"))
                .send()
                .await
                .s3_context("UploadPartCopy")?;
            let etag = response
                .copy_part_result()
                .and_then(|r| r.e_tag())
                .ok_or_else(|| anyhow::anyhow!("Failed to copy part {part_number}"))?;
            parts.push(CompletedPart::builder().e_tag(etag).part_number(part_number as i32).build());
        }
        client
            .complete_multipart_upload()
            .bucket(bucket)
            .key(destination_key)
            .upload_id(&upload_id)
            .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
            .send()
            .await
            .s3_context("CompleteMultipartUpload")?;
        anyhow::Ok(())
    };
    if let Err(e) = copy_parts.await {
        if let Err(abort) = client
            .abort_multipart_upload()
            .bucket(bucket)
            .key(destination_key)
            .upload_id(&upload_id)
            .send()
            .await
        {
            error!("Failed to abort multipart copy: {}", ErrorInfo::of(&abort));
        }
        return Err(e);
    }
    Ok(())
}

/// CopyObject, or a multipart copy above its 5 GiB limit.
async fn copy(client: &Client, bucket: &str, source_key: &str, destination_key: &str, version_id: Option<&str>) -> anyhow::Result<()> {
    let head = client
        .head_object()
        .bucket(bucket)
        .key(source_key)
        .set_version_id(version_id.map(str::to_string))
        .send()
        .await
        .s3_context("HeadObject")?;
    let size = head.content_length().unwrap_or(0);
    if size > MULTIPART_COPY_THRESHOLD {
        return copy_multipart(client, bucket, source_key, destination_key, size, version_id, &head).await;
    }
    client
        .copy_object()
        .bucket(bucket)
        .key(destination_key)
        .copy_source(copy_source(bucket, source_key, version_id))
        .send()
        .await
        .s3_context("CopyObject")?;
    Ok(())
}

async fn delete(client: &Client, bucket: &str, key: &str, version_id: Option<&str>) -> anyhow::Result<()> {
    client
        .delete_object()
        .bucket(bucket)
        .key(key)
        .set_version_id(version_id.map(str::to_string))
        .send()
        .await
        .s3_context("DeleteObject")?;
    Ok(())
}

fn validate_copy_request(body: &CopyRequest) -> Result<(&str, &str), AppError> {
    let (Some(source), Some(destination)) = (
        body.source_key.as_deref().filter(|k| !k.is_empty()),
        body.destination_key.as_deref().filter(|k| !k.is_empty()),
    ) else {
        return Err(AppError::bad_request("sourceKey and destinationKey are required"));
    };
    validate_copy_key(source, "sourceKey")?;
    validate_copy_key(destination, "destinationKey")?;
    if source == destination {
        return Err(AppError::bad_request("Source and destination keys cannot be the same"));
    }
    Ok((source, destination))
}

fn validate_batch(operations: Option<Vec<CopyOperation>>, verb: &str) -> Result<Vec<CopyOperation>, AppError> {
    let operations = operations
        .filter(|o| !o.is_empty())
        .ok_or_else(|| AppError::bad_request("Operations must be a non-empty array"))?;
    if operations.len() > MAX_BATCH_OPERATIONS {
        return Err(AppError::bad_request(format!(
            "Cannot {verb} more than {MAX_BATCH_OPERATIONS} objects at once"
        )));
    }
    for operation in &operations {
        if operation.source_key.is_empty() || operation.destination_key.is_empty() {
            return Err(AppError::bad_request("Each operation must have sourceKey and destinationKey"));
        }
        if operation.source_key == operation.destination_key {
            return Err(AppError::bad_request(format!(
                "sourceKey and destinationKey must differ for operation with key \"{}\"",
                operation.source_key
            )));
        }
        validate_copy_key(&operation.source_key, &format!("sourceKey \"{}\"", operation.source_key))?;
        validate_copy_key(
            &operation.destination_key,
            &format!("destinationKey \"{}\"", operation.destination_key),
        )?;
    }
    Ok(operations)
}

/// Log a per-object failure in full and return the stable message clients
/// see: upstream S3 text stays in the log.
fn failure_message(error: &anyhow::Error, message: &'static str, key: &str) -> &'static str {
    error!("{message} for {key}: {error:#}");
    message
}

async fn copy_object(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<CopyRequest>,
) -> Result<Json<Value>, AppError> {
    let (source, destination) = validate_copy_request(&body)?;
    let context = path.context(&state).await?;
    let version_id = sanitize_version_id(body.version_id.as_deref());
    copy(&context.client, context.require_bucket()?, source, destination, version_id.as_deref()).await?;
    Ok(Json(json!({ "success": true })))
}

/// Each operation independently; failures are reported, not fatal.
async fn batch_copy(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<BatchCopyRequest>,
) -> Result<Json<Value>, AppError> {
    let operations = validate_batch(body.operations, "copy")?;
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let (mut successful, mut errors) = (Vec::new(), Vec::new());
    for operation in &operations {
        let version_id = sanitize_version_id(operation.version_id.as_deref());
        match copy(&context.client, bucket, &operation.source_key, &operation.destination_key, version_id.as_deref()).await {
            Ok(()) => successful.push(operation.source_key.clone()),
            Err(e) => errors.push(json!({
                "sourceKey": operation.source_key,
                "message": failure_message(&e, "Copy failed", &operation.source_key),
            })),
        }
    }
    Ok(Json(json!({ "successful": successful, "errors": errors })))
}

/// Copy then delete the source. If the delete fails the destination already
/// holds the data, and the response says so.
async fn move_object(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<CopyRequest>,
) -> Result<Json<Value>, AppError> {
    let (source, destination) = validate_copy_request(&body)?;
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let version_id = sanitize_version_id(body.version_id.as_deref());
    copy(&context.client, bucket, source, destination, version_id.as_deref()).await?;
    if let Err(e) = delete(&context.client, bucket, source, version_id.as_deref()).await {
        return Err(AppError::Body(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({
                "success": false,
                "message": "Move failed: copy succeeded but source delete failed. Destination key now has the data \
                            and the source still exists; retry the delete or remove the destination to recover.",
                "destinationKey": destination,
                "error": failure_message(&e, "Delete failed", source),
            }),
        ));
    }
    Ok(Json(json!({ "success": true })))
}

async fn batch_move(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiJson(body): ApiJson<BatchCopyRequest>,
) -> Result<Json<Value>, AppError> {
    let operations = validate_batch(body.operations, "move")?;
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let (mut successful, mut errors) = (Vec::new(), Vec::new());
    for operation in &operations {
        let version_id = sanitize_version_id(operation.version_id.as_deref());
        let version_id = version_id.as_deref();
        if let Err(e) = copy(&context.client, bucket, &operation.source_key, &operation.destination_key, version_id).await {
            errors.push(json!({
                "sourceKey": operation.source_key,
                "message": failure_message(&e, "Copy failed", &operation.source_key),
            }));
            continue;
        }
        match delete(&context.client, bucket, &operation.source_key, version_id).await {
            Ok(()) => successful.push(operation.source_key.clone()),
            Err(e) => errors.push(json!({
                "sourceKey": operation.source_key,
                "destinationKey": operation.destination_key,
                "message": failure_message(
                    &e,
                    "Delete failed after successful copy; destination created",
                    &operation.source_key,
                ),
            })),
        }
    }
    Ok(Json(json!({ "successful": successful, "errors": errors })))
}

async fn object_metadata(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BucketPath>,
    ApiQuery(query): ApiQuery<KeyQuery>,
) -> Result<Json<Value>, AppError> {
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let key = validate_object_key(query.key.as_deref(), "Object key is required")?;
    let response = context
        .client
        .head_object()
        .bucket(bucket)
        .key(&key)
        .checksum_mode(ChecksumMode::Enabled)
        .set_version_id(sanitize_version_id(query.version_id.as_deref()))
        .send()
        .await
        .map_err(|e| {
            let info = ErrorInfo::of(&e);
            if info.is_not_found() {
                AppError::not_found("Object not found")
            } else {
                AppError::Internal(anyhow::anyhow!("HeadObject: {info}"))
            }
        })?;
    Ok(Json(json!({
        "key": key,
        "size": response.content_length(),
        "lastModified": response.last_modified().and_then(iso_z),
        "contentType": response.content_type(),
        "etag": response.e_tag(),
        "versionId": response.version_id(),
        "serverSideEncryption": response.server_side_encryption().map(|v| v.as_str()),
        "sseKmsKeyId": response.ssekms_key_id(),
        "sseCustomerAlgorithm": response.sse_customer_algorithm(),
        "storageClass": response.storage_class().map(|v| v.as_str()),
        "vendor": detect_vendor(context.credentials.endpoint.as_deref()),
        "cacheControl": response.cache_control(),
        "contentDisposition": response.content_disposition(),
        "contentEncoding": response.content_encoding(),
        "checksumSHA256": response.checksum_sha256(),
        "checksumSHA1": response.checksum_sha1(),
        "checksumCRC32": response.checksum_crc32(),
        "checksumCRC32C": response.checksum_crc32_c(),
        "checksumCRC64NVME": response.checksum_crc64_nvme(),
        "checksumType": response.checksum_type().map(|v| v.as_str()),
        "userMetadata": response.metadata().cloned().unwrap_or_default(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versioning_not_supported() {
        assert!(is_versioning_not_supported(&ErrorInfo::for_tests(Some("NotImplemented"), Some(400), "boom")));
        assert!(is_versioning_not_supported(&ErrorInfo::for_tests(Some("InternalError"), Some(501), "boom")));
        for message in ["NotImplemented operation", "notimplemented", "NOTIMPLEMENTED", "Not Implemented", "NOT IMPLEMENTED"] {
            assert!(is_versioning_not_supported(&ErrorInfo::for_tests(None, None, message)), "{message}");
        }
        assert!(!is_versioning_not_supported(&ErrorInfo::for_tests(Some("AccessDenied"), Some(403), "boom")));
    }

    #[test]
    fn copy_source_encoding() {
        assert_eq!(copy_source("b", "a dir/報.txt", None), "b/a%20dir/%E5%A0%B1.txt");
        assert_eq!(copy_source("b", "k", Some("v/1+2")), "b/k?versionId=v%2F1%2B2");
    }

    #[test]
    fn search_paging_defaults_and_bounds() {
        assert_eq!(limit_offset(None, None), (100, 0));
        assert_eq!(limit_offset(Some("900"), Some("20")), (500, 20));
        assert_eq!(limit_offset(Some("0"), Some("-5")), (100, 0));
        assert_eq!(limit_offset(Some("x"), Some("y")), (100, 0));
    }
}
