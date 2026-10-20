//! Request validation and response formatting helpers shared by the API routes.

use aws_sdk_s3::primitives::{DateTime, DateTimeFormat};
use serde::{Deserialize, Serialize};

use crate::crypto::{base64_decode, base64_encode};
use crate::error::AppError;

pub const MAX_KEY_BYTES: usize = 1024;

/// RFC 3339 in UTC with a `Z` suffix.
pub fn iso_z(value: &DateTime) -> Option<String> {
    value.fmt(DateTimeFormat::DateTime).ok()
}

pub fn epoch_iso(seconds: i64) -> Option<String> {
    iso_z(&DateTime::from_secs(seconds))
}

/// The last path segment of a key, ignoring one trailing `/` (folders).
pub fn extract_file_name(key: &str) -> &str {
    let clean = key.strip_suffix('/').unwrap_or(key);
    match clean.rsplit('/').next() {
        Some(name) if !name.is_empty() => name,
        _ => clean,
    }
}

fn is_control(c: char) -> bool {
    (c as u32) <= 0x1f || c as u32 == 0x7f
}

pub fn has_unsafe_chars(value: &str) -> bool {
    value.chars().any(|c| is_control(c) || c == '\\')
}

pub fn validate_object_key(value: Option<&str>, message: &str) -> Result<String, AppError> {
    let value = value.filter(|v| !v.is_empty()).ok_or_else(|| AppError::bad_request(message))?;
    if has_unsafe_chars(value) {
        return Err(AppError::bad_request(
            "Invalid character in key: control characters and backslashes not allowed",
        ));
    }
    if value.starts_with('/') {
        return Err(AppError::bad_request("Absolute paths not allowed"));
    }
    if value.split('/').any(|segment| segment == "..") {
        return Err(AppError::bad_request("Directory traversal not allowed"));
    }
    if value.len() > MAX_KEY_BYTES {
        return Err(AppError::bad_request("Key exceeds maximum length of 1024 bytes"));
    }
    Ok(value.to_string())
}

pub fn validate_copy_key(value: &str, label: &str) -> Result<(), AppError> {
    if value.is_empty() {
        return Err(AppError::bad_request(format!(
            "Invalid {label}: Key must be a non-empty string"
        )));
    }
    if value.starts_with('/') || value.split('/').any(|segment| segment == "..") {
        return Err(AppError::bad_request(format!("Invalid {label}: Invalid object key")));
    }
    if value.len() > MAX_KEY_BYTES {
        return Err(AppError::bad_request(format!(
            "Invalid {label}: Key exceeds maximum length of 1024 bytes"
        )));
    }
    Ok(())
}

/// A folder path as a `/`-terminated key: trimmed, no leading or repeated
/// slashes, no `..` segments.
pub fn sanitize_folder_path(value: Option<&str>) -> Result<String, AppError> {
    let value = value.ok_or_else(|| AppError::bad_request("Folder path must be a string"))?;
    let trimmed = value.trim();
    if trimmed.split('/').any(|segment| segment == "..") {
        return Err(AppError::bad_request("Path traversal is not allowed"));
    }
    let segments: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err(AppError::bad_request("Folder path cannot be empty"));
    }
    let folder_path = format!("{}/", segments.join("/"));
    if folder_path.len() > MAX_KEY_BYTES {
        return Err(AppError::bad_request("Folder path exceeds maximum length of 1024 bytes"));
    }
    Ok(folder_path)
}

pub fn sanitize_version_id(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() || has_unsafe_chars(trimmed) {
        return None;
    }
    Some(trimmed.to_string())
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMarkers {
    #[serde(default)]
    pub key_marker: Option<String>,
    #[serde(default)]
    pub version_id_marker: Option<String>,
}

/// The two ListObjectVersions markers as one opaque continuation token.
pub fn encode_version_token(key_marker: Option<&str>, version_id_marker: Option<&str>) -> Option<String> {
    let key_marker = key_marker.filter(|k| !k.is_empty())?;
    let markers = VersionMarkers {
        key_marker: Some(key_marker.to_string()),
        version_id_marker: version_id_marker.map(str::to_string),
    };
    Some(base64_encode(&serde_json::to_vec(&markers).expect("markers serialize")))
}

pub fn decode_version_token(token: Option<&str>) -> VersionMarkers {
    token
        .filter(|t| !t.is_empty())
        .and_then(base64_decode)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .map(|value| VersionMarkers {
            key_marker: value.get("keyMarker").and_then(|v| v.as_str()).map(str::to_string),
            version_id_marker: value.get("versionIdMarker").and_then(|v| v.as_str()).map(str::to_string),
        })
        .unwrap_or_default()
}

fn is_mime_token(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "!#$&-^_.+".contains(c))
}

fn is_param_token(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// A client-supplied content type, if it is a plain `type/subtype` with
/// simple `; key=value` parameters.
pub fn validate_content_type(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    if value.chars().any(is_control) || value.chars().count() > 256 {
        return None;
    }
    let (mime, mut params) = value.split_at(value.find(';').unwrap_or(value.len()));
    let (kind, subtype) = mime.split_once('/')?;
    if !is_mime_token(kind) || !is_mime_token(subtype) {
        return None;
    }
    while !params.is_empty() {
        params = params.strip_prefix(';')?.trim_start();
        let (param, rest) = params.split_at(params.find(';').unwrap_or(params.len()));
        let (key, val) = param.split_once('=')?;
        if !is_param_token(key) || !is_param_token(val) {
            return None;
        }
        params = rest;
    }
    Some(value.to_string())
}

/// An ASCII-only filename safe inside a quoted header parameter.
pub fn sanitize_filename(filename: &str) -> String {
    let mapped: String = filename
        .chars()
        .filter(|&c| !is_control(c) && c != '"' && c != ';')
        .map(|c| if c.is_ascii() { c } else { '_' })
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() { "download".to_string() } else { collapsed }
}

/// Percent-encode everything but unreserved characters and `safe`, as
/// Python's `urllib.parse.quote` does.
pub fn quote(value: &str, safe: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let c = byte as char;
        if byte.is_ascii_alphanumeric() || "_.-~".contains(c) || (byte.is_ascii() && safe.contains(c)) {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn build_content_disposition(disposition: &str, raw_filename: &str) -> String {
    let ascii_name = sanitize_filename(raw_filename);
    let encoded = quote(raw_filename, "/");
    format!("{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bad_request(result: Result<impl std::fmt::Debug, AppError>) -> String {
        match result {
            Err(AppError::Status(status, msg)) if status == 400 => msg,
            other => panic!("expected a 400, got {other:?}"),
        }
    }

    #[test]
    fn object_keys() {
        assert_eq!(validate_object_key(Some("a/b.txt"), "x").unwrap(), "a/b.txt");
        assert_eq!(bad_request(validate_object_key(None, "Key is required")), "Key is required");
        assert_eq!(bad_request(validate_object_key(Some(""), "Key is required")), "Key is required");
        assert!(bad_request(validate_object_key(Some("a\\b"), "x")).starts_with("Invalid character"));
        assert!(bad_request(validate_object_key(Some("a\nb"), "x")).starts_with("Invalid character"));
        assert_eq!(bad_request(validate_object_key(Some("/a"), "x")), "Absolute paths not allowed");
        assert_eq!(bad_request(validate_object_key(Some("a/../b"), "x")), "Directory traversal not allowed");
        assert!(validate_object_key(Some("a/..b/c"), "x").is_ok());
        assert!(validate_object_key(Some(&"é".repeat(513)), "x").is_err());
        assert!(validate_object_key(Some(&"é".repeat(512)), "x").is_ok());
    }

    #[test]
    fn copy_keys() {
        assert!(validate_copy_key("a/b", "sourceKey").is_ok());
        assert_eq!(
            bad_request(validate_copy_key("", "sourceKey")),
            "Invalid sourceKey: Key must be a non-empty string"
        );
        assert_eq!(bad_request(validate_copy_key("/a", "destinationKey")), "Invalid destinationKey: Invalid object key");
    }

    #[test]
    fn folder_paths() {
        assert_eq!(sanitize_folder_path(Some("  //a//b/ ")).unwrap(), "a/b/");
        assert_eq!(sanitize_folder_path(Some("new folder")).unwrap(), "new folder/");
        assert_eq!(bad_request(sanitize_folder_path(Some("a/../b"))), "Path traversal is not allowed");
        assert_eq!(bad_request(sanitize_folder_path(Some(" / "))), "Folder path cannot be empty");
        assert_eq!(bad_request(sanitize_folder_path(None)), "Folder path must be a string");
    }

    #[test]
    fn version_ids_and_tokens() {
        assert_eq!(sanitize_version_id(Some(" v1 ")).as_deref(), Some("v1"));
        assert_eq!(sanitize_version_id(Some("  ")), None);
        assert_eq!(sanitize_version_id(Some("a\u{7f}")), None);
        assert_eq!(sanitize_version_id(None), None);

        assert_eq!(encode_version_token(None, Some("v")), None);
        let token = encode_version_token(Some("k/ü"), None).unwrap();
        assert_eq!(
            decode_version_token(Some(&token)),
            VersionMarkers {
                key_marker: Some("k/ü".into()),
                version_id_marker: None
            }
        );
        // Matches the Python backend's token for the same markers.
        assert_eq!(
            encode_version_token(Some("a"), Some("v1")).unwrap(),
            "eyJrZXlNYXJrZXIiOiJhIiwidmVyc2lvbklkTWFya2VyIjoidjEifQ=="
        );
        assert_eq!(decode_version_token(Some("not base64!")), VersionMarkers::default());
        assert_eq!(decode_version_token(Some("WzFd")), VersionMarkers::default());
    }

    #[test]
    fn content_types() {
        for ok in ["text/plain", "text/plain; charset=utf-8", "application/vnd.api+json;a=b;  c=d"] {
            assert_eq!(validate_content_type(Some(ok)).as_deref(), Some(ok), "{ok}");
        }
        for bad in ["", "text", "/plain", "text/", "text/plain;", "text/plain; a", "text/html\r\nX: y", "te xt/plain", "text/plain; a=b c"] {
            assert_eq!(validate_content_type(Some(bad)), None, "{bad:?}");
        }
        assert_eq!(validate_content_type(Some(&format!("text/{}", "a".repeat(260)))), None);
    }

    #[test]
    fn filenames_and_disposition() {
        assert_eq!(sanitize_filename("a\"b;c\u{1}  d.txt "), "abc d.txt");
        assert_eq!(sanitize_filename("報告.pdf"), "__.pdf");
        assert_eq!(sanitize_filename("\"\""), "download");
        assert_eq!(
            build_content_disposition("attachment", "報告 1.pdf"),
            "attachment; filename=\"__ 1.pdf\"; filename*=UTF-8''%E5%A0%B1%E5%91%8A%201.pdf"
        );
        assert_eq!(quote("a b/c~", ""), "a%20b%2Fc~");
    }

    #[test]
    fn file_names_and_timestamps() {
        assert_eq!(extract_file_name("a/b/c.txt"), "c.txt");
        assert_eq!(extract_file_name("a/b/"), "b");
        assert_eq!(extract_file_name("top"), "top");
        assert_eq!(epoch_iso(1_700_000_000).as_deref(), Some("2023-11-14T22:13:20Z"));
    }
}
