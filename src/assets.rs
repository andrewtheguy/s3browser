//! The web UI, compiled into the binary: `build.rs` stages the frontend
//! bundle in `OUT_DIR` for every build.

use axum::http::{StatusCode, Uri, header};
use axum::response::{Html, IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "$OUT_DIR/frontend-dist"]
struct StaticAssets;

/// Whether a missing path is a static file (404) rather than an SPA route
/// (index.html). Bundled assets live under `assets/`; root-level names with
/// an extension (`favicon.ico`, `favicon.svg`) are files. Deeper paths with dots
/// are SPA routes that embed object keys, like
/// `connection/2/preview/bucket/path/foo.json`.
fn is_static_asset_path(path: &str) -> bool {
    path.starts_with("assets/") || (!path.contains('/') && std::path::Path::new(path).extension().is_some())
}

pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if let Some(file) = StaticAssets::get(path) {
        let mime = new_mime_guess::from_path(path).first_or_octet_stream();
        ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response()
    } else if is_static_asset_path(path) {
        StatusCode::NOT_FOUND.into_response()
    } else if let Some(index) = StaticAssets::get("index.html") {
        Html(index.data).into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_level_files_and_assets_are_static() {
        for path in [
            "assets/index-abc123.js",
            "assets/main.css",
            "favicon.ico",
            "favicon.svg",
            "robots.txt",
            "manifest.json",
        ] {
            assert!(is_static_asset_path(path), "{path}");
        }
    }

    #[tokio::test]
    async fn serves_the_embedded_bundle() {
        let index = static_handler(Uri::from_static("/connection/2/browse/b/")).await;
        assert_eq!(index.status(), StatusCode::OK);
        assert_eq!(index.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
        let missing = static_handler(Uri::from_static("/assets/missing.js")).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn spa_routes_are_not_static() {
        for path in [
            "",
            "connection/2/browse/radio-show/transcripts/rthk-radio2/2026/05/21/",
            // A preview route ending in .json must fall back to index.html.
            "connection/2/preview/radio-show/transcripts/rthk-radio2/2026/05/21/20260521_2200_0000_transcript.json",
            "connection/2/preview/bucket/path/file.m4a",
            "connection/2/preview/bucket/path/note.with.dots.txt",
            "settings",
            "login",
        ] {
            assert!(!is_static_asset_path(path), "{path}");
        }
    }
}
