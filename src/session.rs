//! Single-user sessions. Signing in with the login password sets an HttpOnly
//! cookie holding an HS256 JWT keyed by an scrypt derivation of that password.
//! Tokens expire after 4 hours, and every authenticated API request reissues
//! one, so an active browser stays signed in. Changing the password and
//! restarting invalidates every token.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::crypto::{base64url, base64url_decode, scrypt32};
use crate::error::AppError;
use crate::server::AppState;

pub const AUTH_COOKIE_NAME: &str = "s3browser_auth_token";
const TOKEN_EXPIRATION_SECONDS: i64 = 4 * 60 * 60;
const CLOCK_SKEW_SECONDS: i64 = 30;
const SIGNING_KEY_SALT: &[u8] = b"s3browser-auth-token-v1";
/// `base64url({"alg":"HS256","typ":"JWT"})`.
const JWT_HEADER_B64: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";

/// `/api/*` paths reachable without a session. Everything outside `/api/` is
/// the SPA, which handles signing in itself.
const AUTH_EXEMPT_PATHS: &[&str] = &[
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/status",
    "/api/config",
    "/api/config/",
    "/api/health",
];

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

pub fn ct_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

pub struct SessionKeys {
    signing_key: String,
}

impl SessionKeys {
    /// Derives the signing key, which takes tens of milliseconds; call off the
    /// async executor.
    pub fn new(login_password: &str) -> Self {
        Self {
            signing_key: base64url(&scrypt32(login_password.as_bytes(), SIGNING_KEY_SALT)),
        }
    }

    fn sign(&self, signing_input: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.signing_key.as_bytes()).expect("HMAC accepts any key length");
        mac.update(signing_input.as_bytes());
        base64url(&mac.finalize().into_bytes())
    }

    pub fn create_token(&self, now: i64) -> String {
        let payload = format!(r#"{{"iat":{now},"exp":{}}}"#, now + TOKEN_EXPIRATION_SECONDS);
        let signing_input = format!("{JWT_HEADER_B64}.{}", base64url(payload.as_bytes()));
        let signature = self.sign(&signing_input);
        format!("{signing_input}.{signature}")
    }

    pub fn verify_token(&self, token: &str, now: i64) -> bool {
        let mut parts = token.split('.');
        let (Some(header_b64), Some(payload_b64), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        let Some(header) = decode_json(header_b64) else {
            return false;
        };
        if header.get("alg").and_then(Value::as_str) != Some("HS256")
            || header.get("typ").and_then(Value::as_str) != Some("JWT")
        {
            return false;
        }
        if !ct_eq(signature, &self.sign(&format!("{header_b64}.{payload_b64}"))) {
            return false;
        }
        let Some(payload) = decode_json(payload_b64) else {
            return false;
        };
        let exp = payload.get("exp").and_then(Value::as_i64);
        let iat = payload.get("iat").and_then(Value::as_i64);
        matches!((exp, iat), (Some(exp), Some(iat)) if exp > now && iat <= now + CLOCK_SKEW_SECONDS)
    }
}

fn decode_json(segment: &str) -> Option<Value> {
    serde_json::from_slice(&base64url_decode(segment)?).ok()
}

pub fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

/// Behind a TLS-terminating proxy the cookie is marked `Secure`.
pub fn request_is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|proto| proto.split(',').next().is_some_and(|p| p.trim().eq_ignore_ascii_case("https")))
}

/// A browser-session cookie (no Max-Age): the token inside expires on its own.
pub fn session_cookie(token: &str, secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{AUTH_COOKIE_NAME}={token}; HttpOnly; Path=/; SameSite=lax{secure}"))
        .expect("token is base64url and dots")
}

pub fn clear_cookie() -> HeaderValue {
    HeaderValue::from_static(
        "s3browser_auth_token=\"\"; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; SameSite=lax",
    )
}

pub fn is_authenticated(state: &AppState, headers: &HeaderMap) -> bool {
    cookie_value(headers, AUTH_COOKIE_NAME).is_some_and(|token| state.sessions.verify_token(token, now_secs()))
}

/// Protected `/api/*` requests need a valid session cookie (else 401 and the
/// cookie is cleared), and their responses carry a reissued one.
pub async fn api_auth(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if !path.starts_with("/api/") || AUTH_EXEMPT_PATHS.contains(&path) {
        return next.run(req).await;
    }
    if !is_authenticated(&state, req.headers()) {
        let mut response = AppError::status(StatusCode::UNAUTHORIZED, "Not authenticated").into_response();
        response.headers_mut().append(header::SET_COOKIE, clear_cookie());
        return response;
    }
    let secure = request_is_https(req.headers());
    let mut response = next.run(req).await;
    let token = state.sessions.create_token(now_secs());
    response
        .headers_mut()
        .append(header::SET_COOKIE, session_cookie(&token, secure));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "0123456789abcdef-password";

    #[test]
    fn verifies_tokens_issued_by_the_python_backend() {
        let keys = SessionKeys::new(PASSWORD);
        let token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDAxNDQwMH0.MsGe1vHzOaLNuDX0o_y9YKLdPzKAPUZBwgP1zRL2avA";
        assert_eq!(keys.create_token(1_700_000_000), token);
        assert!(keys.verify_token(token, 1_700_000_000));
        assert!(keys.verify_token(token, 1_700_014_399));
        assert!(!keys.verify_token(token, 1_700_014_400), "expired");
        assert!(!keys.verify_token(token, 1_699_999_969), "issued in the future beyond skew");
    }

    #[test]
    fn rejects_tampered_or_foreign_tokens() {
        let keys = SessionKeys::new(PASSWORD);
        let now = 1_800_000_000;
        let token = keys.create_token(now);
        assert!(keys.verify_token(&token, now));
        assert!(!SessionKeys::new("another-password-0000").verify_token(&token, now));
        assert!(!keys.verify_token(&format!("{token}x"), now));
        assert!(!keys.verify_token(&format!("{token}.extra"), now));
        assert!(!keys.verify_token("", now));

        // A validly signed token with a different algorithm header is refused.
        let header = base64url(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = base64url(format!(r#"{{"iat":{now},"exp":{}}}"#, now + 60).as_bytes());
        let input = format!("{header}.{payload}");
        assert!(!keys.verify_token(&format!("{input}.{}", keys.sign(&input)), now));
    }

    #[test]
    fn cookie_helpers() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "a=b; s3browser_auth_token=tok.en".parse().unwrap());
        assert_eq!(cookie_value(&headers, AUTH_COOKIE_NAME), Some("tok.en"));
        assert!(!request_is_https(&headers));
        headers.insert("x-forwarded-proto", "HTTPS".parse().unwrap());
        assert!(request_is_https(&headers));
        assert_eq!(
            session_cookie("t", true),
            "s3browser_auth_token=t; HttpOnly; Path=/; SameSite=lax; Secure"
        );
    }
}
