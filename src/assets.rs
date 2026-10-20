//! The web UI. Release builds compile the frontend bundle into the binary
//! (`build.rs` stages it in `OUT_DIR` and sets `cfg(embed_frontend)`); dev builds
//! embed nothing and point at the Vite dev server instead.

use axum::response::Response;

/// Whether a missing path is a static file (404) rather than an SPA route
/// (index.html). Bundled assets live under `assets/`; root-level names with
/// an extension (`favicon.ico`, `vite.svg`) are files. Deeper paths with dots
/// are SPA routes that embed object keys, like
/// `connection/2/preview/bucket/path/foo.json`.
#[cfg_attr(not(any(embed_frontend, test)), allow(dead_code))]
fn is_static_asset_path(path: &str) -> bool {
    path.starts_with("assets/") || (!path.contains('/') && std::path::Path::new(path).extension().is_some())
}

#[cfg(embed_frontend)]
mod embedded {
    use axum::{
        http::{StatusCode, header},
        response::{Html, IntoResponse, Response},
    };
    use rust_embed::Embed;

    #[derive(Embed)]
    #[folder = "$OUT_DIR/frontend-dist"]
    struct StaticAssets;

    pub fn serve(uri: &axum::http::Uri) -> Response {
        let path = uri.path().trim_start_matches('/');
        if let Some(file) = StaticAssets::get(path) {
            let mime = new_mime_guess::from_path(path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response()
        } else if super::is_static_asset_path(path) {
            StatusCode::NOT_FOUND.into_response()
        } else if let Some(index) = StaticAssets::get("index.html") {
            Html(index.data).into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

#[cfg(embed_frontend)]
pub async fn static_handler(uri: axum::http::Uri) -> Response {
    embedded::serve(&uri)
}

#[cfg(not(embed_frontend))]
pub async fn static_handler() -> Response {
    use axum::{http::StatusCode, response::IntoResponse};
    (
        StatusCode::NOT_FOUND,
        "frontend is not embedded in this dev build: run `bun run dev` in frontend/ and open http://localhost:5173, or build with --release (or S3BROWSER_EMBED_FRONTEND=1)\n",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::is_static_asset_path;

    #[test]
    fn root_level_files_and_assets_are_static() {
        for path in [
            "assets/index-abc123.js",
            "assets/main.css",
            "favicon.ico",
            "vite.svg",
            "robots.txt",
            "manifest.json",
        ] {
            assert!(is_static_asset_path(path), "{path}");
        }
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
