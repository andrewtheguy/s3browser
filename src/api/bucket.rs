//! `/api/bucket`: versioning, default encryption and lifecycle rules.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use log::warn;
use serde_json::{Value, json};

use crate::error::AppError;
use crate::s3::ErrorInfo;
use crate::server::{ApiPath, AppState, BucketPath};
use crate::validate::iso_z;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/bucket/{connection_id}/{bucket}/info", get(bucket_info))
}

fn is_encryption_not_supported(info: &ErrorInfo) -> bool {
    if info.status == Some(501)
        || info.code_is(&[
            "NotImplemented",
            "NotImplementedException",
            "NotImplementedError",
            "UnsupportedOperation",
        ])
    {
        return true;
    }
    let message = info.message_text().to_lowercase();
    ["not implemented", "notimplemented", "unimplemented"].iter().any(|s| message.contains(s))
}

fn is_lifecycle_not_configured(info: &ErrorInfo) -> bool {
    let not_found = info.status == Some(404);
    if not_found && info.code_is(&["NoSuchLifecycleConfiguration", "NotFound"]) {
        return true;
    }
    let message = info.message_text().to_lowercase();
    if not_found && info.code.is_none() && message.contains("lifecycle") {
        return true;
    }
    message.contains("nosuchlifecycleconfiguration") || message.contains("no such lifecycle configuration")
}

/// Each section is best-effort: a provider that lacks one still shows the rest.
async fn bucket_info(State(state): State<AppState>, ApiPath(path): ApiPath<BucketPath>) -> Result<Json<Value>, AppError> {
    let context = path.context(&state).await?;
    let bucket = context.require_bucket()?;
    let client = &context.client;
    let mut result = json!({
        "versioning": null,
        "encryption": null,
        "encryptionError": null,
        "lifecycleError": null,
        "lifecycleRules": [],
    });

    match client.get_bucket_versioning().bucket(bucket).send().await {
        Ok(output) => {
            result["versioning"] = json!({
                "status": output.status().map(|s| s.as_str()),
                "mfaDelete": output.mfa_delete().map(|m| m.as_str()),
            });
        }
        Err(e) => warn!("Failed to get bucket versioning: {}", ErrorInfo::of(&e)),
    }

    match client.get_bucket_encryption().bucket(bucket).send().await {
        Ok(output) => {
            let default = output
                .server_side_encryption_configuration()
                .and_then(|c| c.rules().first())
                .and_then(|rule| rule.apply_server_side_encryption_by_default());
            if let Some(default) = default {
                result["encryption"] = json!({
                    "algorithm": default.sse_algorithm().as_str(),
                    "kmsKeyId": default.kms_master_key_id(),
                });
            }
        }
        Err(e) => {
            let info = ErrorInfo::of(&e);
            if info.to_string().contains("ServerSideEncryptionConfigurationNotFoundError") {
                // No default encryption configured.
            } else if is_encryption_not_supported(&info) {
                result["encryptionError"] = json!("Not supported by this storage provider");
            } else {
                warn!("Failed to get bucket encryption: {info}");
                result["encryptionError"] = json!(info.to_string());
            }
        }
    }

    match client.get_bucket_lifecycle_configuration().bucket(bucket).send().await {
        Ok(output) => {
            let rules: Vec<Value> = output
                .rules()
                .iter()
                .map(|rule| {
                    let status = rule.status().as_str();
                    let mut item = json!({
                        "id": rule.id(),
                        "status": if status.is_empty() { "Unknown" } else { status },
                        "prefix": rule.filter().and_then(|f| f.prefix()),
                    });
                    if let Some(expiration) = rule.expiration() {
                        item["expiration"] = json!({
                            "days": expiration.days(),
                            "date": expiration.date().and_then(iso_z),
                            "expiredObjectDeleteMarker": expiration.expired_object_delete_marker(),
                        });
                    }
                    if !rule.transitions().is_empty() {
                        item["transitions"] = rule
                            .transitions()
                            .iter()
                            .map(|t| {
                                json!({
                                    "days": t.days(),
                                    "date": t.date().and_then(iso_z),
                                    "storageClass": t.storage_class().map_or("Unknown", |c| c.as_str()),
                                })
                            })
                            .collect();
                    }
                    if let Some(noncurrent) = rule.noncurrent_version_expiration() {
                        item["noncurrentVersionExpiration"] = json!({
                            "days": noncurrent.noncurrent_days(),
                            "newerNoncurrentVersions": noncurrent.newer_noncurrent_versions(),
                        });
                    }
                    if let Some(abort) = rule.abort_incomplete_multipart_upload() {
                        item["abortIncompleteMultipartUpload"] = json!({
                            "daysAfterInitiation": abort.days_after_initiation(),
                        });
                    }
                    item
                })
                .collect();
            result["lifecycleRules"] = Value::Array(rules);
        }
        Err(e) => {
            let info = ErrorInfo::of(&e);
            if !is_lifecycle_not_configured(&info) {
                warn!("Failed to get bucket lifecycle: {info}");
                result["lifecycleError"] = json!(info.to_string());
            }
        }
    }
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(code: Option<&str>, status: Option<u16>, message: &str) -> ErrorInfo {
        ErrorInfo::for_tests(code, status, message)
    }

    #[test]
    fn encryption_not_supported() {
        assert!(is_encryption_not_supported(&error(None, Some(501), "generic 501")));
        for code in ["NotImplemented", "NotImplementedException", "NotImplementedError", "UnsupportedOperation"] {
            assert!(is_encryption_not_supported(&error(Some(code), Some(400), "boom")), "{code}");
        }
        assert!(is_encryption_not_supported(&error(None, None, "This op is unimplemented")));
        assert!(!is_encryption_not_supported(&error(Some("AccessDenied"), Some(403), "boom")));
        assert!(!is_encryption_not_supported(&error(None, None, "permission denied")));
    }

    #[test]
    fn lifecycle_not_configured() {
        assert!(is_lifecycle_not_configured(&error(Some("NoSuchLifecycleConfiguration"), Some(404), "boom")));
        assert!(is_lifecycle_not_configured(&error(Some("NotFound"), Some(404), "boom")));
        assert!(is_lifecycle_not_configured(&error(None, Some(404), "Bucket has no lifecycle policy attached")));
        assert!(!is_lifecycle_not_configured(&error(None, Some(404), "not found")));
        assert!(!is_lifecycle_not_configured(&error(Some("AccessDenied"), Some(403), "boom")));
    }
}
