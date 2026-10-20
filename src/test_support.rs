//! Router-level test helpers: a full `AppState` on temporary databases with an
//! S3 factory that never reaches the network unless a test points it somewhere.

use std::collections::HashMap;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use serde_json::Value;
use tower::ServiceExt;

use crate::config::{Config, ENCRYPTION_KEY_ENV_VAR, LOGIN_PASSWORD_ENV_VAR};
use crate::db::{S3Connection, SaveConnection};
use crate::paths::AppPaths;
use crate::s3::tests::offline_factory;
use crate::server::{AppState, router};
use crate::session::{AUTH_COOKIE_NAME, now_secs};

pub const PASSWORD: &str = "test-login-password";

pub struct TestApp {
    pub state: AppState,
    router: Router,
    _dir: tempfile::TempDir,
}

impl TestApp {
    pub async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let env = HashMap::from([
            (LOGIN_PASSWORD_ENV_VAR, PASSWORD.to_string()),
            (ENCRYPTION_KEY_ENV_VAR, "e".repeat(32)),
        ]);
        let config = Config::resolve(AppPaths::new(dir.path()), None, |key| env.get(key).cloned()).unwrap();
        let state = AppState::new(&config, offline_factory()).await.unwrap();
        Self {
            router: router(state.clone()),
            state,
            _dir: dir,
        }
    }

    pub fn cookie(&self) -> String {
        format!("{AUTH_COOKIE_NAME}={}", self.state.sessions.create_token(now_secs()))
    }

    pub async fn raw(&self, method: Method, path: &str, body: Option<Value>, cookie: Option<&str>) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let request = match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        };
        self.router.clone().oneshot(request.unwrap()).await.unwrap()
    }

    pub async fn request(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        parts(self.raw(method, path, body, None).await).await
    }

    pub async fn authed(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        parts(self.raw(method, path, body, Some(&self.cookie())).await).await
    }

    pub async fn save_connection(&self, profile_name: &str, endpoint: &str) -> S3Connection {
        self.state
            .db
            .save_connection(SaveConnection {
                id: None,
                profile_name,
                endpoint,
                access_key_id: "AK",
                secret_access_key: Some("SECRET"),
                bucket: Some("b"),
                region: Some("us-east-1"),
                auto_detect_region: true,
            })
            .await
            .unwrap()
    }
}

pub async fn parts(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}
