use std::collections::HashSet;
use std::sync::Arc;

use anyhow::Context;
use axum::extract::{DefaultBodyLimit, FromRequest, FromRequestParts, Request, State};
use axum::response::IntoResponse;
use axum::routing::{any, get};
use axum::{Json, Router, middleware};
use bytes::Bytes;
use log::info;
use serde::Deserialize;

use crate::api;
use crate::cli::BindAddress;
use crate::config::{Config, SEARCH_WHITELIST_ENV_VAR, TtlOption};
use crate::db::{Db, IndexDb};
use crate::error::AppError;
use crate::lock::FileLock;
use crate::s3::{S3Context, S3Factory, effective_endpoint_host};
use crate::session::{self, SessionKeys};
use crate::assets;

/// JSON bodies are small except batch ZIP tickets (up to 10,000 entries of
/// two 1 KiB names); uploads check their own 10 MiB limits below this.
const MAX_REQUEST_BODY: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub index_db: IndexDb,
    pub s3: S3Factory,
    pub sessions: Arc<SessionKeys>,
    pub login_password: Arc<str>,
    pub ttl_options: Arc<[TtlOption]>,
    pub search_whitelist: Arc<HashSet<String>>,
    pub seed_test_items: bool,
    pub zip_tickets: Arc<api::download::ZipTickets>,
    pub uploads: Arc<api::upload::UploadTracker>,
}

impl AppState {
    pub async fn new(config: &Config, s3: S3Factory) -> anyhow::Result<Self> {
        let ttl_options = config.presigned_url_ttl_options()?;
        let login_password = config.login_password()?;
        let encryption_key = config.encryption_key_source()?;
        let db = Db::open(&config.paths.db(), &encryption_key).await?;
        let index_db = IndexDb::open(&config.paths.index_db()).await?;
        let password = login_password.clone();
        let sessions = tokio::task::spawn_blocking(move || SessionKeys::new(&password)).await?;
        Ok(Self {
            db,
            index_db,
            s3,
            sessions: Arc::new(sessions),
            login_password: login_password.into(),
            ttl_options: ttl_options.into(),
            search_whitelist: Arc::new(config.search_whitelist_hosts()),
            seed_test_items: config.seed_test_items,
            zip_tickets: Arc::default(),
            uploads: Arc::default(),
        })
    }

    /// Whether search and indexing are allowed on this connection endpoint,
    /// with its host.
    pub fn search_host(&self, endpoint: Option<&str>) -> Option<String> {
        effective_endpoint_host(endpoint).filter(|host| self.search_whitelist.contains(host))
    }
}

/// `axum::extract::Path` with a JSON 422 rejection.
#[derive(FromRequestParts)]
#[from_request(via(axum::extract::Path), rejection(AppError))]
pub struct ApiPath<T>(pub T);

/// `axum::extract::Query` with a JSON 422 rejection.
#[derive(FromRequestParts)]
#[from_request(via(axum::extract::Query), rejection(AppError))]
pub struct ApiQuery<T>(pub T);

/// `axum::Json` with a JSON 422 rejection.
#[derive(FromRequest)]
#[from_request(via(axum::Json), rejection(AppError))]
pub struct ApiJson<T>(pub T);

/// A raw request body with a JSON rejection (413 past the body limit).
pub struct ApiBytes(pub Bytes);

impl<S: Send + Sync> FromRequest<S> for ApiBytes {
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, AppError> {
        Ok(Self(Bytes::from_request(req, state).await?))
    }
}

/// `/{connection_id}/{bucket}` route parameters.
#[derive(Deserialize)]
pub struct BucketPath {
    pub connection_id: i64,
    pub bucket: String,
}

impl BucketPath {
    pub async fn context(self, state: &AppState) -> Result<S3Context, AppError> {
        s3_context(state, self.connection_id, Some(self.bucket)).await
    }
}

/// S3 access for a saved connection, on `bucket` or its default bucket.
pub async fn s3_context(state: &AppState, connection_id: i64, bucket: Option<String>) -> Result<S3Context, AppError> {
    if connection_id <= 0 {
        return Err(AppError::bad_request("Valid connection ID is required"));
    }
    let connection = state
        .db
        .connection(connection_id)
        .await?
        .ok_or_else(|| AppError::not_found("Connection not found"))?;
    state
        .s3
        .context(&state.db, connection, bucket)
        .await
        .map_err(|e| AppError::failed("Failed to initialize S3 connection", format!("{e:#}")))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn client_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "presignedUrlTtls": &*state.ttl_options }))
}

async fn api_not_found() -> impl IntoResponse {
    AppError::not_found("Not found")
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(client_config))
        .route("/api/config/", get(client_config))
        .merge(api::auth::routes())
        .merge(api::objects::routes())
        .merge(api::upload::routes())
        .merge(api::download::routes())
        .merge(api::bucket::routes())
        // Unknown API paths are JSON 404s, not the SPA.
        .route("/api/{*rest}", any(api_not_found))
        .fallback(assets::static_handler)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY))
        .layer(middleware::from_fn_with_state(state.clone(), session::api_auth))
        .with_state(state)
}

pub async fn run(config: Config, bind: BindAddress) -> anyhow::Result<()> {
    // Fail on bad settings before touching anything on disk.
    config.presigned_url_ttl_options()?;
    config.paths.ensure_dir()?;
    let _lock = FileLock::acquire(&config.paths.server_lock())?;
    let state = AppState::new(&config, S3Factory::new().await).await?;
    info!("Database initialized successfully");
    match state.search_whitelist.len() {
        0 => info!("{SEARCH_WHITELIST_ENV_VAR} is unset or empty: search and indexing are disabled for all connections"),
        n => info!("{SEARCH_WHITELIST_ENV_VAR}: {n} host(s) whitelisted for search/indexing"),
    }
    let (db, index_db) = (state.db.clone(), state.index_db.clone());
    let result = serve(router(state), &bind).await;
    db.close().await;
    index_db.close().await;
    result
}

async fn serve(app: Router, bind: &BindAddress) -> anyhow::Result<()> {
    if let Some(path) = &bind.uds {
        return serve_unix(app, path).await;
    }
    let host = bind.host.as_deref().unwrap_or("0.0.0.0");
    let port = bind.port;
    let addr = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind to {addr}"))?;
    let display = match host {
        "0.0.0.0" => "localhost".to_string(),
        host if host.contains(':') => format!("[{host}]"),
        host => host.to_string(),
    };
    // The bound port, which differs from `port` when that is 0.
    info!("S3 Browser running at http://{display}:{}", listener.local_addr()?.port());
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")
}

#[cfg(unix)]
async fn serve_unix(app: Router, path: &std::path::Path) -> anyhow::Result<()> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    // A socket left by an unclean exit; the server lock means no live server owns it.
    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_socket()) {
        std::fs::remove_file(path).with_context(|| format!("failed to remove stale socket {}", path.display()))?;
    }
    let listener = tokio::net::UnixListener::bind(path)
        .with_context(|| format!("failed to bind unix socket {}", path.display()))?;
    // Reachable by a reverse proxy running as another user, as uvicorn did.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))
        .with_context(|| format!("failed to set permissions on {}", path.display()))?;
    info!("S3 Browser running on unix socket {}", path.display());
    let result = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await;
    let _ = std::fs::remove_file(path);
    result.context("server error")
}

#[cfg(not(unix))]
async fn serve_unix(_app: Router, _path: &std::path::Path) -> anyhow::Result<()> {
    anyhow::bail!("unix: bind addresses are only supported on Unix")
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
    info!("shutting down");
}
