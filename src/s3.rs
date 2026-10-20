//! S3 clients for saved connections, error classification, bucket region
//! detection and credential checks.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aws_config::retry::RetryConfig;
use aws_config::timeout::TimeoutConfig;
use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_sdk_s3::config::http::HttpResponse;
use aws_sdk_s3::config::{Credentials, RequestChecksumCalculation, ResponseChecksumValidation};
use aws_sdk_s3::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use log::{info, warn};

use crate::db::{Db, S3Connection};
use crate::error::AppError;
use crate::validate::iso_z;

pub const DEFAULT_REGION: &str = "us-east-1";

pub fn detect_vendor(endpoint: Option<&str>) -> &'static str {
    let Some(endpoint) = endpoint.filter(|e| !e.is_empty()) else {
        return "aws";
    };
    let lower = endpoint.to_lowercase();
    if lower.contains("amazonaws.com") {
        "aws"
    } else if lower.contains("backblazeb2.com") {
        "b2"
    } else {
        "other"
    }
}

/// An endpoint with a scheme (`https://` when none is given), or `None` when
/// the connection talks to AWS directly.
pub fn normalize_endpoint(endpoint: Option<&str>) -> Option<String> {
    let endpoint = endpoint.filter(|e| !e.is_empty())?;
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        Some(endpoint.to_string())
    } else {
        Some(format!("https://{endpoint}"))
    }
}

/// The lowercased hostname of a connection's explicit endpoint.
pub fn effective_endpoint_host(endpoint: Option<&str>) -> Option<String> {
    let normalized = normalize_endpoint(endpoint.map(str::trim))?;
    let after_scheme = normalized.split_once("://").map_or(normalized.as_str(), |(_, rest)| rest);
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = if let Some(bracketed) = host_port.strip_prefix('[') {
        bracketed.split_once(']').map(|(host, _)| host).unwrap_or(bracketed)
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    (!host.is_empty()).then(|| host.to_lowercase())
}

/// What a failed S3 call said: the S3 error code and message (bodyless HEAD
/// responses have neither, only a status), the HTTP status, and readable text.
#[derive(Clone, Debug, Default)]
pub struct ErrorInfo {
    pub code: Option<String>,
    pub message: Option<String>,
    pub status: Option<u16>,
    text: String,
}

impl ErrorInfo {
    pub fn of<E>(e: &SdkError<E, HttpResponse>) -> Self
    where
        E: ProvideErrorMetadata + std::error::Error + 'static,
    {
        let status = e.raw_response().map(|r| r.status().as_u16());
        let code = e.code().filter(|c| !c.is_empty()).map(str::to_string);
        let message = e.message().filter(|m| !m.is_empty()).map(str::to_string);
        // Without a body, name the status: "403: Forbidden".
        let shown_code = code.clone().or_else(|| status.map(|s| s.to_string()));
        let shown_message = message.clone().or_else(|| {
            status
                .and_then(|s| axum::http::StatusCode::from_u16(s).ok())
                .and_then(|s| s.canonical_reason())
                .map(str::to_string)
        });
        let text = match (shown_code, shown_message) {
            (Some(code), Some(message)) if message.contains(code.as_str()) => message,
            (Some(code), Some(message)) => format!("{code}: {message}"),
            (Some(code), None) => code,
            _ => DisplayErrorContext(e).to_string(),
        };
        Self {
            code,
            message,
            status,
            text,
        }
    }

    #[cfg(test)]
    pub fn for_tests(code: Option<&str>, status: Option<u16>, message: &str) -> Self {
        Self {
            code: code.map(str::to_string),
            message: Some(message.to_string()),
            status,
            text: message.to_string(),
        }
    }

    pub fn code_is(&self, codes: &[&str]) -> bool {
        self.code.as_deref().is_some_and(|code| codes.iter().any(|c| c.eq_ignore_ascii_case(code)))
    }

    pub fn is_access_denied(&self) -> bool {
        self.code_is(&["AccessDenied", "Forbidden"])
    }

    pub fn is_not_found(&self) -> bool {
        self.code_is(&["NoSuchKey", "NotFound"]) || self.status == Some(404)
    }

    pub fn is_invalid_credentials(&self) -> bool {
        self.code_is(&["InvalidAccessKeyId", "SignatureDoesNotMatch"])
    }

    /// The message alone, or the readable text when there is none.
    pub fn message_text(&self) -> &str {
        self.message.as_deref().unwrap_or(&self.text)
    }
}

impl fmt::Display for ErrorInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

/// `?` for S3 calls whose failure is an internal error: names the operation
/// and keeps the S3 error code and message.
pub trait S3ResultExt<T> {
    fn s3_context(self, operation: &str) -> anyhow::Result<T>;
}

impl<T, E> S3ResultExt<T> for Result<T, SdkError<E, HttpResponse>>
where
    E: ProvideErrorMetadata + std::error::Error + 'static,
{
    fn s3_context(self, operation: &str) -> anyhow::Result<T> {
        self.map_err(|e| anyhow::anyhow!("{operation}: {}", ErrorInfo::of(&e)))
    }
}

#[derive(Clone, Debug)]
pub struct S3Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
    pub bucket: Option<String>,
    /// Normalized; `None` for AWS.
    pub endpoint: Option<String>,
}

/// Per-request S3 access for one saved connection.
pub struct S3Context {
    pub connection: S3Connection,
    pub client: aws_sdk_s3::Client,
    pub credentials: S3Credentials,
}

impl S3Context {
    pub fn require_bucket(&self) -> Result<&str, AppError> {
        self.credentials
            .bucket
            .as_deref()
            .ok_or_else(|| AppError::bad_request("No bucket selected. Please select a bucket first."))
    }
}

type RegionFuture = Shared<BoxFuture<'static, Result<String, String>>>;

/// Detected bucket regions for auto-detecting connections, keyed by
/// `connection_id:bucket`, with concurrent detections of one key coalesced.
#[derive(Default)]
pub struct RegionCache {
    cache: Mutex<HashMap<String, String>>,
    in_flight: Mutex<HashMap<String, RegionFuture>>,
}

impl RegionCache {
    pub fn clear(&self) {
        self.cache.lock().unwrap().clear();
        info!("Bucket region cache cleared");
    }

    /// Run `detect` unless a detection for `key` is already running, in which
    /// case wait for that one instead.
    async fn detect_deduped<F>(&self, key: &str, detect: F) -> Result<String, String>
    where
        F: Future<Output = Result<String, String>> + Send + 'static,
    {
        let future = self
            .in_flight
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_insert_with(|| detect.boxed().shared())
            .clone();
        let result = future.clone().await;
        let mut in_flight = self.in_flight.lock().unwrap();
        if in_flight.get(key).is_some_and(|current| current.ptr_eq(&future)) {
            in_flight.remove(key);
        }
        result
    }
}

#[derive(Clone)]
pub struct S3Factory {
    base: SdkConfig,
    pub regions: Arc<RegionCache>,
}

impl S3Factory {
    pub async fn new() -> Self {
        let base = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(DEFAULT_REGION))
            // Every client gets its connection's own keys; never fall back to
            // ambient AWS credentials.
            .credentials_provider(Credentials::new("", "", None, None, "unset"))
            .timeout_config(
                TimeoutConfig::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(Duration::from_secs(60))
                    .build(),
            )
            .retry_config(RetryConfig::standard().with_max_attempts(3))
            // S3-compatible stores don't all speak the SDK's default checksums.
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .load()
            .await;
        Self::with_base(base)
    }

    pub fn with_base(base: SdkConfig) -> Self {
        Self {
            base,
            regions: Arc::default(),
        }
    }

    /// Clients share the base config's HTTP connection pool. Custom endpoints
    /// use path-style addressing: S3-compatible stores don't all serve
    /// virtual-hosted bucket names.
    pub fn client(&self, credentials: &S3Credentials) -> aws_sdk_s3::Client {
        let mut builder = aws_sdk_s3::config::Builder::from(&self.base)
            .credentials_provider(Credentials::new(
                &credentials.access_key_id,
                &credentials.secret_access_key,
                None,
                None,
                "s3browser",
            ))
            .region(Region::new(credentials.region.clone()));
        if let Some(endpoint) = &credentials.endpoint {
            builder = builder.endpoint_url(endpoint).force_path_style(true);
        }
        aws_sdk_s3::Client::from_conf(builder.build())
    }

    fn sts_client(&self, access_key_id: &str, secret_access_key: &str, region: &str) -> aws_sdk_sts::Client {
        let config = aws_sdk_sts::config::Builder::from(&self.base)
            .credentials_provider(Credentials::new(access_key_id, secret_access_key, None, None, "s3browser"))
            .region(Region::new(region.to_string()))
            .build();
        aws_sdk_sts::Client::from_conf(config)
    }

    /// The bucket's AWS region. Custom endpoints are always `us-east-1`.
    pub async fn bucket_region(
        &self,
        access_key_id: &str,
        secret_access_key: &str,
        bucket: &str,
        endpoint: Option<&str>,
    ) -> Result<String, String> {
        if endpoint.is_some_and(|e| !e.is_empty()) {
            return Ok(DEFAULT_REGION.to_string());
        }
        let client = self.client(&S3Credentials {
            access_key_id: access_key_id.to_string(),
            secret_access_key: secret_access_key.to_string(),
            region: DEFAULT_REGION.to_string(),
            bucket: None,
            endpoint: None,
        });
        match client.get_bucket_location().bucket(bucket).send().await {
            Ok(output) => Ok(match output.location_constraint().map(|c| c.as_str()) {
                None | Some("") => DEFAULT_REGION.to_string(),
                Some("EU") => "eu-west-1".to_string(),
                Some(region) => region.to_string(),
            }),
            Err(e) => {
                // S3 names a bucket's region in this header even on redirects
                // and denials.
                let header = e
                    .raw_response()
                    .and_then(|r| r.headers().get("x-amz-bucket-region"))
                    .filter(|r| !r.is_empty());
                if let Some(region) = header {
                    return Ok(region.to_string());
                }
                warn!("Failed to get bucket location: {}", ErrorInfo::of(&e));
                Err("Failed to detect bucket region. Please specify the region manually.".to_string())
            }
        }
    }

    /// Per-request S3 access for a saved connection, on `bucket` or else the
    /// connection's default bucket.
    pub async fn context(&self, db: &Db, connection: S3Connection, bucket: Option<String>) -> anyhow::Result<S3Context> {
        let secret = db.decrypt_secret(&connection)?;
        let endpoint = normalize_endpoint(Some(&connection.endpoint));
        let bucket = bucket.filter(|b| !b.is_empty()).or_else(|| connection.bucket.clone());
        let mut region = connection.region.clone().unwrap_or_else(|| DEFAULT_REGION.to_string());
        if let (true, Some(bucket), None) = (connection.auto_detect_region, &bucket, &endpoint) {
            let key = format!("{}:{bucket}", connection.id);
            let cached = self.regions.cache.lock().unwrap().get(&key).cloned();
            if let Some(cached) = cached {
                region = cached;
            } else {
                let factory = self.clone();
                let (access_key_id, secret_key, bucket_name) =
                    (connection.access_key_id.clone(), secret.clone(), bucket.clone());
                let detect =
                    async move { factory.bucket_region(&access_key_id, &secret_key, &bucket_name, None).await };
                match self.regions.detect_deduped(&key, detect).await {
                    Ok(detected) => {
                        self.regions.cache.lock().unwrap().insert(key, detected.clone());
                        region = detected;
                    }
                    Err(e) => warn!("Failed to auto-detect bucket region, using connection region: {e}"),
                }
            }
        }
        let credentials = S3Credentials {
            access_key_id: connection.access_key_id.clone(),
            secret_access_key: secret,
            region,
            bucket,
            endpoint,
        };
        db.touch_connection(connection.id).await?;
        Ok(S3Context {
            client: self.client(&credentials),
            connection,
            credentials,
        })
    }

    /// Check keys against a specific bucket. Access denied still proves the
    /// keys are real.
    pub async fn validate_credentials(&self, credentials: &S3Credentials) -> Result<(), String> {
        let bucket = credentials.bucket.as_deref().unwrap_or_default();
        match self.client(credentials).head_bucket().bucket(bucket).send().await {
            Ok(_) => Ok(()),
            Err(e) => {
                let info = ErrorInfo::of(&e);
                if info.code_is(&["NotFound"]) {
                    Err("Bucket not found".to_string())
                } else if info.is_access_denied() {
                    Ok(())
                } else if info.is_invalid_credentials() {
                    Err("Invalid credentials".to_string())
                } else {
                    Err(info.to_string())
                }
            }
        }
    }

    /// Check keys without a bucket: ListBuckets on a custom endpoint, STS
    /// GetCallerIdentity on AWS (falling back to ListBuckets where a policy
    /// blocks STS).
    pub async fn validate_credentials_only(
        &self,
        access_key_id: &str,
        secret_access_key: &str,
        region: &str,
        endpoint: Option<&str>,
    ) -> Result<(), String> {
        let credentials = S3Credentials {
            access_key_id: access_key_id.to_string(),
            secret_access_key: secret_access_key.to_string(),
            region: region.to_string(),
            bucket: None,
            endpoint: normalize_endpoint(endpoint),
        };
        if credentials.endpoint.is_some() {
            return match self.client(&credentials).list_buckets().send().await {
                Ok(_) => Ok(()),
                Err(e) => {
                    let info = ErrorInfo::of(&e);
                    if info.is_access_denied() { Ok(()) } else { Err(info.to_string()) }
                }
            };
        }
        let sts = self.sts_client(access_key_id, secret_access_key, region);
        let Err(e) = sts.get_caller_identity().send().await else {
            return Ok(());
        };
        let info = ErrorInfo::of(&e);
        if !info.is_access_denied() {
            return Err(info.to_string());
        }
        match self.client(&credentials).list_buckets().send().await {
            Ok(_) => Ok(()),
            Err(e) => {
                let info = ErrorInfo::of(&e);
                if info.is_access_denied() {
                    Ok(())
                } else {
                    Err(format!("STS blocked by policy and S3 check failed: {info}"))
                }
            }
        }
    }

    /// Head a bucket for the bucket picker. Access denied still lets the user in.
    pub async fn validate_bucket(&self, client: &aws_sdk_s3::Client, bucket: &str) -> Result<(), String> {
        match client.head_bucket().bucket(bucket).send().await {
            Ok(_) => Ok(()),
            Err(e) => {
                let info = ErrorInfo::of(&e);
                if info.code_is(&["NotFound"]) {
                    Err("Bucket not found".to_string())
                } else if info.is_access_denied() {
                    Ok(())
                } else {
                    Err(info.to_string())
                }
            }
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketItem {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
}

pub async fn list_user_buckets(client: &aws_sdk_s3::Client) -> Result<Vec<BucketItem>, ErrorInfo> {
    let output = client.list_buckets().send().await.map_err(|e| ErrorInfo::of(&e))?;
    Ok(output
        .buckets()
        .iter()
        .filter_map(|bucket| {
            Some(BucketItem {
                name: bucket.name().filter(|n| !n.is_empty())?.to_string(),
                creation_date: bucket.creation_date().and_then(iso_z),
            })
        })
        .collect())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use aws_sdk_s3::presigning::PresigningConfig;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub fn offline_factory() -> S3Factory {
        S3Factory::with_base(
            SdkConfig::builder()
                .behavior_version(BehaviorVersion::latest())
                .region(Region::new(DEFAULT_REGION))
                .build(),
        )
    }

    fn credentials(endpoint: Option<&str>) -> S3Credentials {
        S3Credentials {
            access_key_id: "AKIAEXAMPLE".into(),
            secret_access_key: "secret".into(),
            region: DEFAULT_REGION.into(),
            bucket: None,
            endpoint: normalize_endpoint(endpoint),
        }
    }

    async fn presigned_get_url(endpoint: Option<&str>, key: &str) -> String {
        offline_factory()
            .client(&credentials(endpoint))
            .get_object()
            .bucket("radio-show")
            .key(key)
            .presigned(PresigningConfig::expires_in(Duration::from_secs(3600)).unwrap())
            .await
            .unwrap()
            .uri()
            .to_string()
    }

    fn assert_sigv4_query(url: &str) {
        let query = url.split_once('?').unwrap().1;
        assert!(query.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"), "{url}");
        assert!(query.contains("X-Amz-Signature="), "{url}");
        for legacy in ["AWSAccessKeyId=", "&Signature=", "&Expires="] {
            assert!(!query.contains(legacy), "{url}");
        }
    }

    #[tokio::test]
    async fn custom_endpoint_presigned_url_uses_sigv4_and_path_style() {
        let url = presigned_get_url(Some("https://objstore.local.168234.xyz"), "shows/test.m4a").await;
        assert!(url.starts_with("https://objstore.local.168234.xyz/radio-show/shows/test.m4a?"), "{url}");
        assert_sigv4_query(&url);

        let url = presigned_get_url(
            Some("objstore.local.168234.xyz"),
            "shows/rthk-radio2/2026/05/21/20260521_2200_0000_她．他．它.m4a",
        )
        .await;
        assert!(
            url.starts_with(
                "https://objstore.local.168234.xyz/radio-show/shows/rthk-radio2/2026/05/21/\
                 20260521_2200_0000_%E5%A5%B9%EF%BC%8E%E4%BB%96%EF%BC%8E%E5%AE%83.m4a?"
            ),
            "{url}"
        );
        assert_sigv4_query(&url);
    }

    #[tokio::test]
    async fn aws_presigned_url_uses_sigv4() {
        let url = presigned_get_url(None, "shows/test.m4a").await;
        assert!(url.contains("amazonaws.com"), "{url}");
        assert_sigv4_query(&url);
    }

    #[test]
    fn endpoints_vendors_and_hosts() {
        assert_eq!(normalize_endpoint(Some("minio:9000")).as_deref(), Some("https://minio:9000"));
        assert_eq!(normalize_endpoint(Some("http://x")).as_deref(), Some("http://x"));
        assert_eq!(normalize_endpoint(Some("")), None);
        assert_eq!(detect_vendor(None), "aws");
        assert_eq!(detect_vendor(Some("https://s3.us-west-2.amazonaws.com")), "aws");
        assert_eq!(detect_vendor(Some("https://s3.us-west-004.BackblazeB2.com")), "b2");
        assert_eq!(detect_vendor(Some("http://127.0.0.1:9000")), "other");
        for (endpoint, host) in [
            (" https://MinIO.Example.com:9000/path ", Some("minio.example.com")),
            ("objstore.local", Some("objstore.local")),
            ("http://user:pw@host.lan:80", Some("host.lan")),
            ("http://[::1]:9000", Some("::1")),
            ("", None),
            ("https://", None),
        ] {
            assert_eq!(effective_endpoint_host(Some(endpoint)).as_deref(), host, "{endpoint}");
        }
    }

    #[test]
    fn error_classification() {
        assert!(ErrorInfo::for_tests(Some("AccessDenied"), Some(403), "x").is_access_denied());
        assert!(ErrorInfo::for_tests(Some("forbidden"), None, "x").is_access_denied());
        // A bodyless 403 (bad keys on HEAD) is not "access denied".
        assert!(!ErrorInfo::for_tests(None, Some(403), "Forbidden").is_access_denied());
        assert!(ErrorInfo::for_tests(Some("NoSuchKey"), Some(404), "x").is_not_found());
        assert!(ErrorInfo::for_tests(None, Some(404), "x").is_not_found());
        assert!(!ErrorInfo::for_tests(Some("AccessDenied"), Some(403), "x").is_not_found());
    }

    #[tokio::test]
    async fn detect_deduped_coalesces_concurrent_callers() {
        let cache = Arc::new(RegionCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let detect = || {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok("eu-west-1".to_string())
            }
        };
        let results = futures::future::join_all((0..5).map(|_| cache.detect_deduped("conn:bucket", detect()))).await;
        assert_eq!(results, vec![Ok("eu-west-1".to_string()); 5]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(cache.in_flight.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn detect_deduped_propagates_errors_to_waiters() {
        let cache = RegionCache::default();
        let detect = || async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Err("region detection failed".to_string())
        };
        let results = futures::future::join_all((0..3).map(|_| cache.detect_deduped("c:b", detect()))).await;
        assert_eq!(results, vec![Err("region detection failed".to_string()); 3]);
        assert!(cache.in_flight.lock().unwrap().is_empty());
    }
}
