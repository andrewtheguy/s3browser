use axum::Json;
use axum::extract::rejection::{BytesRejection, JsonRejection, PathRejection, QueryRejection};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use log::error;
use serde_json::{Value, json};

/// API errors. Every variant renders as a JSON object with an `error` string,
/// which is what the frontend reads (`frontend/src/services/api/client.ts`);
/// `Coded` adds a machine-readable `code`. Internal errors hide their chain
/// from the client and log it.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{1}")]
    Status(StatusCode, String),

    #[error("{message}")]
    Coded {
        status: StatusCode,
        message: String,
        code: &'static str,
    },

    /// A JSON object body that already carries its own `error` field.
    #[error("{1}")]
    Body(StatusCode, Value),

    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    pub fn status(status: StatusCode, msg: impl Into<String>) -> Self {
        Self::Status(status, msg.into())
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::status(StatusCode::BAD_REQUEST, msg)
    }

    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::status(StatusCode::UNAUTHORIZED, msg)
    }

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::status(StatusCode::FORBIDDEN, msg)
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::status(StatusCode::NOT_FOUND, msg)
    }

    pub fn coded(status: StatusCode, msg: impl Into<String>, code: &'static str) -> Self {
        Self::Coded {
            status,
            message: msg.into(),
            code,
        }
    }

    /// A 500 with a specific client-facing message; the cause is only logged.
    pub fn failed(msg: &'static str, cause: impl std::fmt::Display) -> Self {
        error!("{msg}: {cause}");
        Self::status(StatusCode::INTERNAL_SERVER_ERROR, msg)
    }
}

fn invalid_request(detail: String) -> AppError {
    AppError::status(StatusCode::UNPROCESSABLE_ENTITY, format!("Invalid request: {detail}"))
}

impl From<PathRejection> for AppError {
    fn from(e: PathRejection) -> Self {
        invalid_request(e.body_text())
    }
}

impl From<QueryRejection> for AppError {
    fn from(e: QueryRejection) -> Self {
        invalid_request(e.body_text())
    }
}

impl From<JsonRejection> for AppError {
    fn from(e: JsonRejection) -> Self {
        match e {
            // Not an invalid request: a body past the limit keeps its 413.
            JsonRejection::BytesRejection(e) => e.into(),
            e => invalid_request(e.body_text()),
        }
    }
}

impl From<BytesRejection> for AppError {
    fn from(e: BytesRejection) -> Self {
        Self::status(e.status(), e.body_text())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        Self::Internal(anyhow::Error::new(e).context("database error"))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            AppError::Status(status, msg) => (status, json!({ "error": msg })),
            AppError::Coded { status, message, code } => (status, json!({ "error": message, "code": code })),
            AppError::Body(status, body) => (status, body),
            AppError::Internal(err) => {
                error!("internal error: {err:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "Internal server error" }))
            }
        };
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn response_parts(error: AppError) -> (StatusCode, Value) {
        let response = error.into_response();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn client_errors_return_status_and_error() {
        let (status, body) = response_parts(AppError::not_found("Connection not found")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, json!({ "error": "Connection not found" }));

        let (status, body) =
            response_parts(AppError::coded(StatusCode::FORBIDDEN, "Search disabled", "EndpointNotWhitelisted")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, json!({ "error": "Search disabled", "code": "EndpointNotWhitelisted" }));
    }

    #[tokio::test]
    async fn internal_errors_hide_error_chain_from_clients() {
        let (status, body) = response_parts(AppError::Internal(anyhow::anyhow!("secret leaked"))).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, json!({ "error": "Internal server error" }));

        let (status, body) = response_parts(AppError::failed("Upload part failed", "s3 secret in error")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, json!({ "error": "Upload part failed" }));
    }
}
