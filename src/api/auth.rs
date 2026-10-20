//! `/api/auth`: signing in and out, and saved S3 connections.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use super::ClearRegionCacheQuery;
use crate::db::{S3Connection, SaveConnection, SaveError};
use crate::error::AppError;
use crate::s3::{DEFAULT_REGION, S3Credentials, detect_vendor, list_user_buckets, normalize_endpoint};
use crate::server::{ApiJson, ApiPath, ApiQuery, AppState, s3_context};
use crate::session::{self, ct_eq, now_secs};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/status", get(status))
        .route("/api/auth/connections", post(save_connection).get(list_connections))
        .route("/api/auth/connections/{connection_id}", get(get_connection).delete(delete_connection))
        .route("/api/auth/connections/{connection_id}/export", post(export_connection))
        .route("/api/auth/buckets/{connection_id}", get(list_buckets))
        .route("/api/auth/validate-bucket/{connection_id}", post(validate_bucket))
        .route("/api/auth/test-connection", post(test_connection))
}

#[derive(Deserialize)]
struct LoginRequest {
    password: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionRequest {
    connection_id: Option<i64>,
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
    region: Option<String>,
    bucket: Option<String>,
    endpoint: Option<String>,
    profile_name: Option<String>,
    auto_detect_region: Option<bool>,
}

#[derive(Deserialize)]
struct SelectBucketRequest {
    bucket: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ExportFormat {
    Aws,
    Rclone,
}

#[derive(Deserialize)]
struct ExportProfileRequest {
    format: ExportFormat,
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

fn connection_json(state: &AppState, connection: &S3Connection) -> Value {
    json!({
        "id": connection.id,
        "profileName": connection.profile_name,
        "endpoint": connection.endpoint,
        "accessKeyId": connection.access_key_id,
        "bucket": connection.bucket,
        "region": connection.region,
        "autoDetectRegion": connection.auto_detect_region,
        "lastUsedAt": connection.last_used_at * 1000,
        "searchEnabled": state.search_host(Some(&connection.endpoint)).is_some(),
    })
}

async fn login(State(state): State<AppState>, headers: HeaderMap, ApiJson(body): ApiJson<LoginRequest>) -> Result<Response, AppError> {
    let password = non_empty(&body.password).ok_or_else(|| AppError::bad_request("Password is required"))?;
    if !ct_eq(password, &state.login_password) {
        return Err(AppError::unauthorized("Invalid password"));
    }
    let token = state.sessions.create_token(now_secs());
    let cookie = session::session_cookie(&token, session::request_is_https(&headers));
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "success": true }))).into_response())
}

async fn logout(State(state): State<AppState>) -> Response {
    state.s3.regions.clear();
    ([(header::SET_COOKIE, session::clear_cookie())], Json(json!({ "success": true }))).into_response()
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let authenticated = session::is_authenticated(&state, &headers);
    let body = Json(json!({ "authenticated": authenticated }));
    if authenticated {
        body.into_response()
    } else {
        ([(header::SET_COOKIE, session::clear_cookie())], body).into_response()
    }
}

/// Check a connection's keys, against its bucket when one is given.
async fn validate_keys(state: &AppState, access_key_id: &str, secret: &str, region: &str, body: &ConnectionRequest) -> Result<(), AppError> {
    let result = match non_empty(&body.bucket) {
        Some(bucket) => {
            state
                .s3
                .validate_credentials(&S3Credentials {
                    access_key_id: access_key_id.to_string(),
                    secret_access_key: secret.to_string(),
                    region: region.to_string(),
                    bucket: Some(bucket.to_string()),
                    endpoint: normalize_endpoint(body.endpoint.as_deref()),
                })
                .await
        }
        None => {
            state
                .s3
                .validate_credentials_only(access_key_id, secret, region, body.endpoint.as_deref())
                .await
        }
    };
    result.map_err(|e| AppError::unauthorized(if e.is_empty() { "Invalid credentials".to_string() } else { e }))
}

async fn save_connection(State(state): State<AppState>, ApiJson(body): ApiJson<ConnectionRequest>) -> Result<Json<Value>, AppError> {
    let access_key_id = non_empty(&body.access_key_id).ok_or_else(|| AppError::bad_request("Access key ID is required"))?;
    let profile_name = body
        .profile_name
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| AppError::bad_request("Profile name is required"))?;
    let existing = match body.connection_id {
        Some(id) if id <= 0 => return Err(AppError::bad_request("Invalid connection ID")),
        Some(id) => Some(
            state
                .db
                .connection(id)
                .await?
                .ok_or_else(|| AppError::not_found("Connection not found"))?,
        ),
        None => None,
    };
    let secret = match (non_empty(&body.secret_access_key), &existing) {
        (Some(secret), _) => secret.to_string(),
        (None, Some(existing)) => state.db.decrypt_secret(existing)?,
        (None, None) => return Err(AppError::bad_request("Secret access key is required for new connections")),
    };
    let bucket = non_empty(&body.bucket);
    let region = match (non_empty(&body.region), bucket) {
        (Some(region), _) => region.to_string(),
        (None, Some(bucket)) => state
            .s3
            .bucket_region(access_key_id, &secret, bucket, body.endpoint.as_deref())
            .await
            .map_err(AppError::bad_request)?,
        (None, None) => DEFAULT_REGION.to_string(),
    };
    validate_keys(&state, access_key_id, &secret, &region, &body).await?;
    let saved = state
        .db
        .save_connection(SaveConnection {
            id: body.connection_id,
            profile_name,
            endpoint: body.endpoint.as_deref().unwrap_or_default(),
            access_key_id,
            secret_access_key: non_empty(&body.secret_access_key),
            bucket,
            region: Some(&region),
            auto_detect_region: body.auto_detect_region != Some(false),
        })
        .await
        .map_err(|e| match e {
            SaveError::DuplicateProfile => AppError::bad_request("Profile name already exists"),
            SaveError::NotFound => AppError::not_found("Connection not found"),
            SaveError::Other(e) => AppError::failed("Failed to save connection", format!("{e:#}")),
        })?;
    Ok(Json(json!({
        "success": true,
        "connectionId": saved.id,
        "region": region,
        "bucket": bucket,
        "endpoint": non_empty(&body.endpoint),
        "searchEnabled": state.search_host(body.endpoint.as_deref()).is_some(),
    })))
}

async fn list_connections(State(state): State<AppState>, ApiQuery(query): ApiQuery<ClearRegionCacheQuery>) -> Result<Json<Value>, AppError> {
    if query.requested() {
        state.s3.regions.clear();
    }
    let connections: Vec<Value> = state
        .db
        .connections()
        .await?
        .iter()
        .map(|c| connection_json(&state, c))
        .collect();
    Ok(Json(json!({ "connections": connections })))
}

async fn get_connection(State(state): State<AppState>, ApiPath(connection_id): ApiPath<i64>) -> Result<Json<Value>, AppError> {
    if connection_id <= 0 {
        return Err(AppError::bad_request("Invalid connection ID"));
    }
    let connection = state
        .db
        .connection(connection_id)
        .await?
        .ok_or_else(|| AppError::not_found("Connection not found"))?;
    Ok(Json(connection_json(&state, &connection)))
}

async fn delete_connection(State(state): State<AppState>, ApiPath(connection_id): ApiPath<i64>) -> Result<Json<Value>, AppError> {
    if connection_id <= 0 {
        return Err(AppError::bad_request("Valid connection ID is required"));
    }
    if !state.db.delete_connection(connection_id).await? {
        return Err(AppError::not_found("Connection not found"));
    }
    Ok(Json(json!({ "success": true })))
}

async fn list_buckets(
    State(state): State<AppState>,
    ApiPath(connection_id): ApiPath<i64>,
    ApiQuery(query): ApiQuery<ClearRegionCacheQuery>,
) -> Result<Json<Value>, AppError> {
    if query.requested() {
        state.s3.regions.clear();
    }
    let context = s3_context(&state, connection_id, None).await?;
    match list_user_buckets(&context.client).await {
        Ok(buckets) => Ok(Json(json!({ "buckets": buckets }))),
        Err(info) => {
            let text = info.to_string();
            let lower = text.to_lowercase();
            Err(if ["signature", "credential", "invalidaccesskeyid"].iter().any(|s| lower.contains(s)) {
                AppError::unauthorized("Authentication failed")
            } else if lower.contains("accessdenied") || lower.contains("forbidden") {
                AppError::forbidden("Access denied")
            } else {
                AppError::status(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    if text.is_empty() { "Failed to list buckets".to_string() } else { text },
                )
            })
        }
    }
}

async fn validate_bucket(
    State(state): State<AppState>,
    ApiPath(connection_id): ApiPath<i64>,
    ApiJson(body): ApiJson<SelectBucketRequest>,
) -> Result<Json<Value>, AppError> {
    let bucket = non_empty(&body.bucket).ok_or_else(|| AppError::bad_request("Bucket name is required"))?;
    let context = s3_context(&state, connection_id, None).await?;
    state
        .s3
        .validate_bucket(&context.client, bucket)
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(json!({ "success": true, "bucket": bucket })))
}

async fn test_connection(State(state): State<AppState>, ApiJson(body): ApiJson<ConnectionRequest>) -> Result<Json<Value>, AppError> {
    let (Some(access_key_id), Some(secret)) = (non_empty(&body.access_key_id), non_empty(&body.secret_access_key)) else {
        return Err(AppError::bad_request("Missing required credentials"));
    };
    let region = non_empty(&body.region).unwrap_or(DEFAULT_REGION);
    validate_keys(&state, access_key_id, secret, region, &body).await?;
    Ok(Json(json!({ "success": true })))
}

/// Characters other than `[A-Za-z0-9+=,.@_-]` become `_`.
fn sanitize_profile_name(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    let base = if trimmed.is_empty() { fallback } else { trimmed };
    base.chars()
        .map(|c| if c.is_ascii_alphanumeric() || "+=,.@_-".contains(c) { c } else { '_' })
        .collect()
}

/// A download filename that is valid on Windows too.
fn sanitize_export_filename(name: &str) -> String {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
        "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "s3-connection".to_string();
    }
    let replaced: String = trimmed
        .chars()
        .map(|c| {
            let unsafe_char = (c as u32) <= 0x1f || c as u32 == 0x7f || "\\/:*?\"<>|".contains(c) || c.is_whitespace();
            if unsafe_char { '_' } else { c }
        })
        .collect();
    let mut sanitized = replaced.trim_end_matches(['.', ' ']).to_string();
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&sanitized)) {
        sanitized.insert(0, '_');
    }
    if sanitized.is_empty() { "s3-connection".to_string() } else { sanitized }
}

fn aws_profile(profile_name: &str, access_key_id: &str, secret: &str, region: &str, endpoint: Option<&str>) -> String {
    let header = if profile_name == "default" {
        "[default]".to_string()
    } else {
        format!("[profile {profile_name}]")
    };
    let mut lines = vec![header, format!("region = {region}"), "output = json".to_string()];
    if let Some(endpoint) = endpoint {
        lines.push(format!("endpoint_url = {endpoint}"));
    }
    lines.push(format!("aws_access_key_id = {access_key_id}"));
    lines.push(format!("aws_secret_access_key = {secret}"));
    lines.push(String::new());
    lines.join("\n")
}

fn rclone_profile(profile_name: &str, access_key_id: &str, secret: &str, region: &str, provider: &str, endpoint: Option<&str>) -> String {
    let mut lines = vec![
        format!("[{profile_name}]"),
        "type = s3".to_string(),
        format!("provider = {provider}"),
        format!("access_key_id = {access_key_id}"),
        format!("secret_access_key = {secret}"),
    ];
    if !region.is_empty() {
        lines.push(format!("region = {region}"));
    }
    if let Some(endpoint) = endpoint {
        lines.push(format!("endpoint = {endpoint}"));
    }
    lines.push(String::new());
    lines.join("\n")
}

/// Decrypts the saved secret into an AWS CLI or rclone profile for download.
async fn export_connection(
    State(state): State<AppState>,
    ApiPath(connection_id): ApiPath<i64>,
    ApiJson(body): ApiJson<ExportProfileRequest>,
) -> Result<Response, AppError> {
    if connection_id <= 0 {
        return Err(AppError::bad_request("Valid connection ID is required"));
    }
    let connection = state
        .db
        .connection(connection_id)
        .await?
        .ok_or_else(|| AppError::not_found("Connection not found"))?;
    let secret = state.db.decrypt_secret(&connection)?;
    let profile_name = sanitize_profile_name(&connection.profile_name, &format!("connection-{}", connection.id));
    let filename_base = sanitize_export_filename(&profile_name);
    let endpoint = normalize_endpoint(Some(&connection.endpoint));
    let vendor = detect_vendor(endpoint.as_deref());
    let region = connection.region.as_deref().unwrap_or(DEFAULT_REGION);
    let (filename, content) = match body.format {
        ExportFormat::Aws => (
            format!("{filename_base}.aws-config"),
            aws_profile(
                &profile_name,
                &connection.access_key_id,
                &secret,
                region,
                endpoint.as_deref().filter(|_| vendor != "aws"),
            ),
        ),
        ExportFormat::Rclone => {
            let provider = match vendor {
                "b2" => "Backblaze",
                "aws" => "AWS",
                _ => "Other",
            };
            (
                format!("{filename_base}.rclone.conf"),
                rclone_profile(&profile_name, &connection.access_key_id, &secret, region, provider, endpoint.as_deref()),
            )
        }
    };
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "filename": filename, "content": content })),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestApp;
    use axum::http::Method;

    #[test]
    fn profile_and_filename_sanitizing() {
        assert_eq!(sanitize_profile_name(" my prod/西 ", "fallback"), "my_prod__");
        assert_eq!(sanitize_profile_name("  ", "connection-3"), "connection-3");
        assert_eq!(sanitize_export_filename("con"), "_con");
        assert_eq!(sanitize_export_filename("a:b?. ."), "a_b_._");
        assert_eq!(sanitize_export_filename("a:b?.."), "a_b_");
        assert_eq!(sanitize_export_filename("..."), "s3-connection");
    }

    #[test]
    fn profile_text() {
        assert_eq!(
            aws_profile("default", "AK", "SK", "us-east-1", None),
            "[default]\nregion = us-east-1\noutput = json\naws_access_key_id = AK\naws_secret_access_key = SK\n"
        );
        assert_eq!(
            rclone_profile("b2", "AK", "SK", "us-west-004", "Backblaze", Some("https://s3.us-west-004.backblazeb2.com")),
            "[b2]\ntype = s3\nprovider = Backblaze\naccess_key_id = AK\nsecret_access_key = SK\nregion = us-west-004\n\
             endpoint = https://s3.us-west-004.backblazeb2.com\n"
        );
    }

    #[tokio::test]
    async fn login_sets_a_session_cookie_that_unlocks_the_api() {
        let app = TestApp::new().await;
        let (status, body) = app.request(Method::GET, "/api/auth/connections", None).await;
        assert_eq!((status, body), (StatusCode::UNAUTHORIZED, json!({ "error": "Not authenticated" })));

        let (status, body) = app.request(Method::POST, "/api/auth/login", Some(json!({ "password": "nope" }))).await;
        assert_eq!((status, body), (StatusCode::UNAUTHORIZED, json!({ "error": "Invalid password" })));
        let (status, body) = app.request(Method::POST, "/api/auth/login", Some(json!({}))).await;
        assert_eq!((status, body), (StatusCode::BAD_REQUEST, json!({ "error": "Password is required" })));

        let response = app.raw(Method::POST, "/api/auth/login", Some(json!({ "password": crate::test_support::PASSWORD })), None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
        assert!(cookie.starts_with("s3browser_auth_token=") && cookie.contains("HttpOnly"), "{cookie}");
        let token = cookie.split(';').next().unwrap().to_string();

        let response = app.raw(Method::GET, "/api/auth/connections", None, Some(&token)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let refreshed = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(refreshed.starts_with("s3browser_auth_token="), "sliding session: {refreshed}");

        let response = app.raw(Method::GET, "/api/auth/status", None, Some(&token)).await;
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        let (status, body) = app.request(Method::GET, "/api/auth/status", None).await;
        assert_eq!((status, body), (StatusCode::OK, json!({ "authenticated": false })));
    }

    #[tokio::test]
    async fn connection_routes_validate_ids_and_bodies() {
        let app = TestApp::new().await;
        let (status, body) = app.authed(Method::GET, "/api/auth/connections/0", None).await;
        assert_eq!((status, body), (StatusCode::BAD_REQUEST, json!({ "error": "Invalid connection ID" })));
        let (status, _) = app.authed(Method::GET, "/api/auth/connections/abc", None).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, body) = app.authed(Method::DELETE, "/api/auth/connections/42", None).await;
        assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({ "error": "Connection not found" })));
        let (status, body) = app.authed(Method::POST, "/api/auth/connections", Some(json!({ "profileName": "x" }))).await;
        assert_eq!((status, body), (StatusCode::BAD_REQUEST, json!({ "error": "Access key ID is required" })));
        let (status, body) = app
            .authed(Method::POST, "/api/auth/connections", Some(json!({ "profileName": "x", "accessKeyId": "AK" })))
            .await;
        assert_eq!(
            (status, body),
            (StatusCode::BAD_REQUEST, json!({ "error": "Secret access key is required for new connections" }))
        );
        let (status, _) = app
            .authed(Method::POST, "/api/auth/connections/1/export", Some(json!({ "format": "s3cmd" })))
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, body) = app.authed(Method::GET, "/api/objects/7/b", None).await;
        assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({ "error": "Connection not found" })));
        let (status, body) = app.authed(Method::GET, "/api/nope", None).await;
        assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({ "error": "Not found" })));
    }

    #[tokio::test]
    async fn public_routes() {
        let app = TestApp::new().await;
        let (status, body) = app.request(Method::GET, "/api/health", None).await;
        assert_eq!((status, body), (StatusCode::OK, json!({ "status": "ok" })));
        let (status, body) = app.request(Method::GET, "/api/config", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({ "presignedUrlTtls": [
                { "ttl": 3600, "shortLabel": "1h", "longLabel": "1 hour" },
                { "ttl": 86400, "shortLabel": "1d", "longLabel": "1 day" },
            ] })
        );
    }

    #[tokio::test]
    async fn export_decrypts_the_saved_secret() {
        let app = TestApp::new().await;
        let saved = app.save_connection("prod box", "https://s3.us-west-004.backblazeb2.com").await;
        let (status, body) = app
            .authed(Method::POST, &format!("/api/auth/connections/{}/export", saved.id), Some(json!({ "format": "rclone" })))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["filename"], "prod_box.rclone.conf");
        let content = body["content"].as_str().unwrap();
        assert!(content.contains("provider = Backblaze\n") && content.contains("secret_access_key = SECRET\n"), "{content}");

        let (_, body) = app.authed(Method::GET, "/api/auth/connections", None).await;
        assert_eq!(body["connections"][0]["profileName"], "prod box");
        assert_eq!(body["connections"][0]["searchEnabled"], false);
        assert!(body["connections"][0].get("secretAccessKey").is_none());
    }
}
