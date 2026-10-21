//! End-to-end tests: the real `s3browser` binary (`server`, `index`) against a
//! live S3 (Silo). Ignored by default; `scripts/e2e.sh` starts Silo and runs
//! them with the `S3BROWSER_E2E_*` environment set.
//!
//! Every test gets its own HOME (so its own `~/.s3browser`) and bucket, so
//! tests run in parallel.

use std::io::{Cursor, Read};
use std::net::TcpListener;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{
    BucketVersioningStatus, ObjectLockLegalHold, ObjectLockLegalHoldStatus, VersioningConfiguration,
};
use rand::Rng;
use reqwest::StatusCode;
use reqwest::header;
use serde_json::{Value, json};
use tempfile::TempDir;

const PASSWORD: &str = "e2e-login-password";
const ENCRYPTION_KEY: &str = "e2e-encryption-key-0123456789abcdef";
/// The host `S3BROWSER_E2E_S3_ENDPOINT` points at, allowlisted for search.
const SEARCH_HOST: &str = "127.0.0.1";

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set; run the e2e suite via scripts/e2e.sh"))
}

struct Services {
    s3_endpoint: String,
    s3_access_key_id: String,
    s3_secret_access_key: String,
    s3_region: String,
}

impl Services {
    fn from_env() -> Self {
        Self {
            s3_endpoint: env("S3BROWSER_E2E_S3_ENDPOINT"),
            s3_access_key_id: env("S3BROWSER_E2E_S3_ACCESS_KEY_ID"),
            s3_secret_access_key: env("S3BROWSER_E2E_S3_SECRET_ACCESS_KEY"),
            s3_region: env("S3BROWSER_E2E_S3_REGION"),
        }
    }
}

/// A fresh bucket and HOME plus an S3 client for seeding and asserting.
struct Fixture {
    services: Services,
    bucket: String,
    home: TempDir,
    s3: aws_sdk_s3::Client,
}

impl Fixture {
    async fn new() -> Self {
        Self::create(false).await
    }

    /// A bucket with object lock (so versioning) on, where a legal hold makes
    /// S3 refuse to delete one version.
    async fn with_object_lock() -> Self {
        Self::create(true).await
    }

    async fn create(object_lock: bool) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let services = Services::from_env();
        let bucket = format!(
            "s3browser-e2e-{}-{}-{:06x}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
            rand::rng().random_range(0..0xFF_FFFF)
        );
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
            .region(aws_sdk_s3::config::Region::new(services.s3_region.clone()))
            .endpoint_url(&services.s3_endpoint)
            .credentials_provider(aws_sdk_s3::config::Credentials::new(
                &services.s3_access_key_id,
                &services.s3_secret_access_key,
                None,
                None,
                "e2e",
            ))
            .force_path_style(true)
            .build();
        let s3 = aws_sdk_s3::Client::from_conf(config);
        s3.create_bucket()
            .bucket(&bucket)
            .object_lock_enabled_for_bucket(object_lock)
            .send()
            .await
            .expect("create bucket");
        Self {
            services,
            bucket,
            home: TempDir::new().expect("temp HOME"),
            s3,
        }
    }

    /// Empty and delete the bucket, every version included. Not a `Drop`: a
    /// failed test keeps its bucket for inspection.
    async fn cleanup(self) {
        // Test buckets hold far fewer than one page of versions.
        let page = self.s3.list_object_versions().bucket(&self.bucket).send().await.expect("list versions");
        assert_ne!(page.is_truncated(), Some(true));
        let versions = page.versions().iter().map(|v| (v.key(), v.version_id()));
        let markers = page.delete_markers().iter().map(|m| (m.key(), m.version_id()));
        for (key, version_id) in versions.chain(markers) {
            self.s3
                .delete_object()
                .bucket(&self.bucket)
                .key(key.unwrap())
                .set_version_id(version_id.map(str::to_string))
                .send()
                .await
                .expect("delete version");
        }
        self.s3.delete_bucket().bucket(&self.bucket).send().await.expect("delete bucket");
    }

    async fn put(&self, key: &str, body: impl Into<Vec<u8>>) {
        self.s3
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(body.into()))
            .send()
            .await
            .unwrap_or_else(|e| panic!("put {key}: {e:?}"));
    }

    async fn put_typed(&self, key: &str, content_type: Option<&str>, body: &'static [u8]) {
        self.s3
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .set_content_type(content_type.map(str::to_string))
            .body(ByteStream::from_static(body))
            .send()
            .await
            .unwrap_or_else(|e| panic!("put {key}: {e:?}"));
    }

    /// Put `key` under a legal hold; returns the held version's ID.
    async fn put_held(&self, key: &str, body: &'static [u8]) -> String {
        let response = self
            .s3
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .object_lock_legal_hold_status(ObjectLockLegalHoldStatus::On)
            .body(ByteStream::from_static(body))
            .send()
            .await
            .unwrap_or_else(|e| panic!("put held {key}: {e:?}"));
        response.version_id().expect("versioned bucket").to_string()
    }

    async fn release(&self, key: &str, version_id: &str) {
        self.s3
            .put_object_legal_hold()
            .bucket(&self.bucket)
            .key(key)
            .version_id(version_id)
            .legal_hold(ObjectLockLegalHold::builder().status(ObjectLockLegalHoldStatus::Off).build())
            .send()
            .await
            .unwrap_or_else(|e| panic!("release {key}: {e:?}"));
    }

    async fn get(&self, key: &str) -> Vec<u8> {
        let response = self
            .s3
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .unwrap_or_else(|e| panic!("get {key}: {e:?}"));
        response.body.collect().await.unwrap().into_bytes().to_vec()
    }

    async fn keys(&self) -> Vec<String> {
        let mut pages = self.s3.list_objects_v2().bucket(&self.bucket).into_paginator().send();
        let mut keys = Vec::new();
        while let Some(page) = pages.next().await {
            let page = page.expect("list objects");
            keys.extend(page.contents().iter().filter_map(|o| o.key().map(str::to_string)));
        }
        keys.sort();
        keys
    }

    /// `s3browser` with this fixture's HOME, run outside the repo so a
    /// developer's `.env` is not picked up.
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_s3browser"));
        command
            .args(args)
            .current_dir(env!("CARGO_TARGET_TMPDIR"))
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home.path())
            .env("RUST_LOG", "warn")
            .env("S3BROWSER_LOGIN_PASSWORD", PASSWORD)
            .env("S3BROWSER_ENCRYPTION_KEY", ENCRYPTION_KEY)
            .env("S3BROWSER_SEARCH_WHITELIST_HOSTS", SEARCH_HOST);
        command
    }

    /// `s3browser index` for a connection and bucket.
    fn index(&self, connection_id: i64) -> Output {
        self.command(&["index", "--connection", &connection_id.to_string(), "--bucket", &self.bucket])
            .output()
            .expect("run s3browser index")
    }

    /// A logged-in server with a saved connection to this fixture's bucket.
    async fn server(&self) -> Server {
        let mut server = Server::start(self.command(&[])).await;
        server.connection = server.save_connection(&self.services, &self.services.s3_endpoint, &self.bucket).await;
        server
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// A running `s3browser server`, killed on drop. The client keeps the
/// session cookie.
struct Server {
    child: Child,
    base: String,
    http: reqwest::Client,
    connection: i64,
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

impl Server {
    /// Spawn on a free port, wait for the listener, then log in.
    async fn start(mut command: Command) -> Self {
        let port = free_port();
        let child = command
            .args(["server", "--bind", &format!("127.0.0.1:{port}")])
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn s3browser server");
        let http = reqwest::Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let mut server = Self {
            child,
            base: format!("http://127.0.0.1:{port}"),
            http,
            connection: 0,
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = server.child.try_wait().unwrap() {
                panic!("server exited early: {status}");
            }
            if server.http.get(server.url("/api/health")).send().await.is_ok() {
                break;
            }
            assert!(Instant::now() < deadline, "server did not start listening");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let (status, body) = server.post_json("/api/auth/login", json!({ "password": PASSWORD })).await;
        assert_eq!((status, body), (StatusCode::OK, json!({ "success": true })));
        server
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// `/api/{area}/{connection}/{bucket}{rest}` for the saved connection.
    fn bucket_path(&self, area: &str, bucket: &str, rest: &str) -> String {
        format!("/api/{area}/{}/{bucket}{rest}", self.connection)
    }

    async fn get_json(&self, path: &str) -> (StatusCode, Value) {
        send_json(self.http.get(self.url(path))).await
    }

    async fn post_json(&self, path: &str, body: Value) -> (StatusCode, Value) {
        send_json(self.http.post(self.url(path)).json(&body)).await
    }

    async fn save_connection(&self, services: &Services, endpoint: &str, bucket: &str) -> i64 {
        let (status, body) = self
            .post_json(
                "/api/auth/connections",
                json!({
                    "profileName": format!("e2e {endpoint} {bucket}"),
                    "accessKeyId": services.s3_access_key_id,
                    "secretAccessKey": services.s3_secret_access_key,
                    "region": services.s3_region,
                    "endpoint": endpoint,
                    "bucket": bucket,
                }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["connectionId"].as_i64().expect("connectionId")
    }

    /// The keys of one listing page under a prefix.
    async fn list(&self, bucket: &str, prefix: &str) -> Vec<String> {
        let path = self.bucket_path("objects", bucket, &format!("?prefix={}", urlencode(prefix)));
        let (status, body) = self.get_json(&path).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["objects"].as_array().unwrap().iter().map(|o| o["key"].as_str().unwrap().to_string()).collect()
    }

    async fn download(&self, bucket: &str, key: &str, range: Option<&str>) -> reqwest::Response {
        let path = self.bucket_path("download", bucket, &format!("/object?key={}", urlencode(key)));
        let mut request = self.http.get(self.url(&path));
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        request.send().await.unwrap()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn urlencode(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

async fn send_json(request: reqwest::RequestBuilder) -> (StatusCode, Value) {
    send_json_response(request.send().await.unwrap()).await
}

async fn send_json_response(response: reqwest::Response) -> (StatusCode, Value) {
    let status = response.status();
    let body = response.text().await.unwrap();
    let value = serde_json::from_str(&body).unwrap_or_else(|_| panic!("non-JSON body ({status}): {body}"));
    (status, value)
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

#[tokio::test]
#[ignore = "needs Silo; run scripts/e2e.sh"]
async fn auth_and_connections() {
    let fx = Fixture::new().await;
    let server = fx.server().await;

    let (status, body) = server.get_json("/api/auth/connections").await;
    assert_eq!(status, StatusCode::OK);
    let connections = body["connections"].as_array().unwrap();
    assert_eq!(connections.len(), 1);
    assert_eq!(connections[0]["bucket"], fx.bucket.as_str());
    assert_eq!(connections[0]["searchEnabled"], true);
    assert_eq!(connections[0]["recentBuckets"], json!([]));
    assert!(connections[0].get("secretAccessKey").is_none());

    let (status, body) = server.get_json(&format!("/api/auth/buckets/{}", server.connection)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["buckets"].as_array().unwrap().iter().any(|b| b["name"] == fx.bucket.as_str()), "{body}");

    let (status, body) = server
        .post_json(
            &format!("/api/auth/validate-bucket/{}", server.connection),
            json!({ "bucket": fx.bucket }),
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "success": true, "bucket": fx.bucket })));

    let (status, _) = server
        .post_json(
            "/api/auth/test-connection",
            json!({
                "accessKeyId": fx.services.s3_access_key_id,
                "secretAccessKey": "wrong-secret",
                "endpoint": fx.services.s3_endpoint,
                "region": fx.services.s3_region,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Testing an existing connection without retyping its secret uses the stored one.
    let (status, body) = server
        .post_json(
            "/api/auth/test-connection",
            json!({
                "connectionId": server.connection,
                "accessKeyId": fx.services.s3_access_key_id,
                "endpoint": fx.services.s3_endpoint,
                "region": fx.services.s3_region,
            }),
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "success": true })));

    let (status, body) = server
        .post_json(&format!("/api/auth/connections/{}/export", server.connection), json!({ "format": "aws" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let content = body["content"].as_str().unwrap();
    assert!(content.contains(&format!("aws_secret_access_key = {}", fx.services.s3_secret_access_key)), "{content}");
    assert!(content.contains(&format!("endpoint_url = {}", fx.services.s3_endpoint)), "{content}");

    let (status, body) = server
        .post_json(&format!("/api/auth/connections/{}/export", server.connection), json!({ "format": "rclone" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["content"].as_str().unwrap().contains("provider = Other"), "{body}");

    // A saved secret survives a restart: it is decrypted with the same key.
    let connection = server.connection;
    drop(server);
    let mut server = Server::start(fx.command(&[])).await;
    server.connection = connection;
    assert_eq!(server.list(&fx.bucket, "").await, Vec::<String>::new());

    // Opening a bucket records it as recently used on the connection.
    let (status, body) = server.get_json("/api/auth/connections").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["connections"][0]["recentBuckets"][0]["name"], fx.bucket.as_str(), "{body}");

    let response = server
        .http
        .delete(server.url(&format!("/api/auth/connections/{connection}")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (status, body) = server.get_json(&server.bucket_path("objects", &fx.bucket, "")).await;
    assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({ "error": "Connection not found" })));

    let (status, _) = server.post_json("/api/auth/logout", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = server.get_json("/api/auth/connections").await;
    assert_eq!((status, body), (StatusCode::UNAUTHORIZED, json!({ "error": "Not authenticated", "code": "NotAuthenticated" })));
    drop(server);
    fx.cleanup().await;
}

#[tokio::test]
#[ignore = "needs Silo; run scripts/e2e.sh"]
async fn upload_list_download_delete() {
    let fx = Fixture::new().await;
    let server = fx.server().await;
    let bucket = fx.bucket.as_str();

    let response = server
        .http
        .post(server.url(&server.bucket_path("upload", bucket, "/single?key=docs%2Fhello%20world.txt")))
        .header(header::CONTENT_TYPE, "text/plain")
        .body("hello, world")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(fx.get("docs/hello world.txt").await, b"hello, world");

    // 12 MiB goes up as a 10 MiB part and a 2 MiB part.
    let big = pattern(12 * 1024 * 1024);
    let (status, body) = server
        .post_json(
            &server.bucket_path("upload", bucket, "/initiate"),
            json!({ "key": "big.bin", "contentType": "application/octet-stream", "fileSize": big.len() }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["totalParts"], 2);
    let upload_id = body["uploadId"].as_str().unwrap().to_string();
    let part_size = body["partSize"].as_u64().unwrap() as usize;
    let mut parts = Vec::new();
    for (index, chunk) in big.chunks(part_size).enumerate() {
        let path = format!("/part?uploadId={}&key=big.bin&partNumber={}", urlencode(&upload_id), index + 1);
        let (status, body) = send_json(
            server.http.post(server.url(&server.bucket_path("upload", bucket, &path))).body(chunk.to_vec()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        parts.push(json!({ "partNumber": index + 1, "etag": body["etag"] }));
    }
    // A part for another key is refused.
    let path = format!("/part?uploadId={}&key=other.bin&partNumber=1", urlencode(&upload_id));
    let (status, _) = send_json(server.http.post(server.url(&server.bucket_path("upload", bucket, &path))).body("x")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = server
        .post_json(
            &server.bucket_path("upload", bucket, "/complete"),
            json!({ "uploadId": upload_id, "key": "big.bin", "parts": parts }),
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "success": true, "key": "big.bin" })));
    assert_eq!(fx.get("big.bin").await, big);

    let (status, body) = server
        .post_json(&server.bucket_path("objects", bucket, "/folder"), json!({ "path": "empty" }))
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "success": true, "key": "empty/" })));

    assert_eq!(server.list(bucket, "").await, ["docs/", "empty/", "big.bin"]);
    assert_eq!(server.list(bucket, "docs/").await, ["docs/hello world.txt"]);

    let response = server.download(bucket, "big.bin", None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_LENGTH], big.len().to_string().as_str());
    assert_eq!(response.bytes().await.unwrap().as_ref(), big.as_slice());

    let response = server.download(bucket, "big.bin", Some("bytes=100-199")).await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers()[header::CONTENT_RANGE],
        format!("bytes 100-199/{}", big.len()).as_str()
    );
    assert_eq!(response.bytes().await.unwrap().as_ref(), &big[100..200]);

    let response = server.download(bucket, "missing.bin", None).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let path = server.bucket_path("download", bucket, "/url?key=docs%2Fhello%20world.txt&ttl=3600");
    let (status, body) = server.get_json(&path).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let presigned = body["url"].as_str().unwrap();
    let response = reqwest::get(presigned).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK, "{presigned}");
    assert_eq!(response.text().await.unwrap(), "hello, world");

    let path = server.bucket_path("objects", bucket, "/metadata?key=docs%2Fhello%20world.txt");
    let (status, body) = server.get_json(&path).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!((body["size"].as_i64(), body["contentType"].as_str()), (Some(12), Some("text/plain")));

    let response = server
        .http
        .delete(server.url(&server.bucket_path("objects", bucket, "?key=big.bin")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // Keys are used exactly as sent: "pad " is not "pad".
    fx.put("pad ", b"x".to_vec()).await;
    fx.put("pad", b"y".to_vec()).await;
    let (status, body) = server
        .post_json(&server.bucket_path("objects", bucket, "/batch-delete"), json!({ "keys": [{ "key": "pad " }] }))
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "deleted": [{ "key": "pad " }], "errors": [] })));
    assert_eq!(fx.get("pad").await, b"y");

    let (status, body) = server
        .post_json(
            &server.bucket_path("objects", bucket, "/batch-delete"),
            json!({ "keys": [{ "key": "docs/hello world.txt" }, { "key": "empty/" }, { "key": "pad" }] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Folder markers are skipped unless a version is named.
    assert_eq!(body["deleted"], json!([{ "key": "docs/hello world.txt" }, { "key": "pad" }]));
    let response = server
        .http
        .delete(server.url(&server.bucket_path("objects", bucket, "?key=empty%2F")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(fx.keys().await, Vec::<String>::new());
    drop(server);
    fx.cleanup().await;
}

#[tokio::test]
#[ignore = "needs Silo; run scripts/e2e.sh"]
async fn copy_and_move() {
    let fx = Fixture::new().await;
    let server = fx.server().await;
    let bucket = fx.bucket.as_str();
    for key in ["a.txt", "b.txt", "c.txt", "d.txt"] {
        fx.put(key, key.as_bytes().to_vec()).await;
    }

    let (status, body) = server
        .post_json(
            &server.bucket_path("objects", bucket, "/copy"),
            json!({ "sourceKey": "a.txt", "destinationKey": "copies/a.txt" }),
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "success": true })));
    let (status, body) = server
        .post_json(
            &server.bucket_path("objects", bucket, "/copy"),
            json!({ "sourceKey": "a.txt", "destinationKey": "a.txt" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (status, body) = server
        .post_json(
            &server.bucket_path("objects", bucket, "/batch-copy"),
            json!({ "operations": [
                { "sourceKey": "b.txt", "destinationKey": "copies/b.txt" },
                { "sourceKey": "missing.txt", "destinationKey": "copies/missing.txt" },
            ] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // A failure names its object and keeps the upstream S3 text in the log.
    assert_eq!(
        body,
        json!({ "successful": ["b.txt"], "errors": [{ "sourceKey": "missing.txt", "message": "Copy failed" }] })
    );

    let (status, body) = server
        .post_json(
            &server.bucket_path("objects", bucket, "/move"),
            json!({ "sourceKey": "c.txt", "destinationKey": "moved/c.txt" }),
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "success": true })));
    let (status, body) = server
        .post_json(
            &server.bucket_path("objects", bucket, "/batch-move"),
            json!({ "operations": [{ "sourceKey": "d.txt", "destinationKey": "moved/d.txt" }] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["successful"], json!(["d.txt"]));

    assert_eq!(
        fx.keys().await,
        ["a.txt", "b.txt", "copies/a.txt", "copies/b.txt", "moved/c.txt", "moved/d.txt"]
    );
    assert_eq!(fx.get("moved/d.txt").await, b"d.txt");
    drop(server);
    fx.cleanup().await;
}

#[tokio::test]
#[ignore = "needs Silo; run scripts/e2e.sh"]
async fn versions_and_bucket_info() {
    let fx = Fixture::new().await;
    fx.s3
        .put_bucket_versioning()
        .bucket(&fx.bucket)
        .versioning_configuration(VersioningConfiguration::builder().status(BucketVersioningStatus::Enabled).build())
        .send()
        .await
        .expect("enable versioning");
    fx.put("v.txt", b"first".to_vec()).await;
    fx.put("v.txt", b"second".to_vec()).await;
    let server = fx.server().await;
    let bucket = fx.bucket.as_str();

    let (status, body) = server.get_json(&server.bucket_path("bucket", bucket, "/info")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["versioning"]["status"], "Enabled", "{body}");

    let (status, body) = server.get_json(&server.bucket_path("objects", bucket, "?versions=1")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let versions = body["objects"].as_array().unwrap();
    assert_eq!(versions.len(), 2, "{body}");
    let old = versions.iter().find(|v| v["isLatest"] == false).expect("non-current version");
    let old_id = old["versionId"].as_str().unwrap();

    let path = server.bucket_path(
        "download",
        bucket,
        &format!("/object?key=v.txt&versionId={}", urlencode(old_id)),
    );
    let response = server.http.get(server.url(&path)).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "first");
    drop(server);
    fx.cleanup().await;
}

#[tokio::test]
#[ignore = "needs Silo; run scripts/e2e.sh"]
async fn batch_zip_download() {
    let fx = Fixture::new().await;
    let big = pattern(3 * 1024 * 1024 + 7);
    fx.put("photos/2024/a.bin", big.clone()).await;
    fx.put("notes.txt", b"note".to_vec()).await;
    let server = fx.server().await;
    let bucket = fx.bucket.as_str();

    let (status, body) = server
        .post_json(
            &server.bucket_path("download", bucket, "/batch-zip-ticket"),
            json!({
                "archiveName": "bundle.zip",
                "entries": [
                    { "key": "photos/2024/a.bin", "name": "2024/a.bin" },
                    { "key": "notes.txt", "name": "notes.txt" },
                    { "key": "gone.txt", "name": "gone.txt" },
                ],
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ticket = body["ticket"].as_str().unwrap().to_string();
    let path = format!("/api/download/{}/{bucket}/batch-zip?ticket={}", server.connection, urlencode(&ticket));
    let response = server.http.get(server.url(&path)).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let disposition = response.headers()[header::CONTENT_DISPOSITION].to_str().unwrap().to_string();
    assert!(disposition.contains("bundle.zip"), "{disposition}");
    let bytes = response.bytes().await.unwrap();

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).expect("valid zip");
    let read = |archive: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str| {
        let mut out = Vec::new();
        archive.by_name(name).unwrap_or_else(|e| panic!("{name}: {e}")).read_to_end(&mut out).unwrap();
        out
    };
    assert_eq!(read(&mut archive, "2024/a.bin"), big);
    assert_eq!(read(&mut archive, "notes.txt"), b"note");
    let manifest = String::from_utf8(read(&mut archive, "_download-errors.txt")).unwrap();
    assert!(manifest.contains("gone.txt"), "{manifest}");

    // Tickets are single use.
    let response = server.http.get(server.url(&path)).send().await.unwrap();
    assert!(response.status().is_client_error(), "{}", response.status());
    drop(server);
    fx.cleanup().await;
}

#[tokio::test]
#[ignore = "needs Silo; run scripts/e2e.sh"]
async fn index_and_search() {
    let fx = Fixture::new().await;
    fx.put("docs/readme.md", b"The quick brown fox jumps over the lazy dog".to_vec()).await;
    fx.put("docs/notes.txt", b"nothing to see here".to_vec()).await;
    fx.put("img/fox.png", pattern(64)).await;
    let server = fx.server().await;
    let bucket = fx.bucket.as_str();

    let (status, body) = server.get_json(&server.bucket_path("objects", bucket, "/index-status")).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "lastIndexedAt": null, "objectCount": null })));

    let output = fx.index(server.connection);
    assert!(output.status.success(), "index failed:\n{}{}", stdout(&output), stderr(&output));
    assert!(stdout(&output).contains("Done. Indexed 3 keys (added=3"), "{}", stdout(&output));

    let (status, body) = server.get_json(&server.bucket_path("objects", bucket, "/index-status")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["objectCount"], 3, "{body}");

    let (status, body) = server.get_json(&server.bucket_path("objects", bucket, "/search?q=fox")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut keys: Vec<&str> = body["objects"].as_array().unwrap().iter().map(|o| o["key"].as_str().unwrap()).collect();
    keys.sort();
    // One key match and one content match.
    assert_eq!(keys, ["docs/readme.md", "img/fox.png"], "{body}");
    let readme = body["objects"].as_array().unwrap().iter().find(|o| o["key"] == "docs/readme.md").unwrap();
    assert!(readme["contentSnippet"].as_str().unwrap().contains("fox"), "{readme}");

    // A rerun sweeps deleted objects and fetches only changed ones.
    fx.s3.delete_object().bucket(bucket).key("img/fox.png").send().await.unwrap();
    let output = fx.index(server.connection);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("removed=1"), "{}", stdout(&output));
    assert!(stdout(&output).contains("skipped(unchanged)=2"), "{}", stdout(&output));
    let (_, body) = server.get_json(&server.bucket_path("objects", bucket, "/search?q=fox")).await;
    assert_eq!(body["total"], 1, "{body}");

    // A connection whose endpoint host is not allowlisted is refused by both.
    let other_endpoint = fx.services.s3_endpoint.replace("127.0.0.1", "localhost");
    let other = server.save_connection(&fx.services, &other_endpoint, bucket).await;
    let output = fx.index(other);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("is not in S3BROWSER_SEARCH_WHITELIST_HOSTS"), "{}", stderr(&output));
    let (status, _) = server.get_json(&format!("/api/objects/{other}/{bucket}/search?q=fox")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    drop(server);
    fx.cleanup().await;
}

/// Stored content that would run script if a browser rendered it.
const ACTIVE: &[u8] = b"<html><script>fetch('/api/auth/connections')</script></html>";
/// `SVG_INLINE_CSP` in `src/api/download.rs`.
const SVG_CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
const OCTET_STREAM: &str = "application/octet-stream";

/// How a download response tells the browser to treat its body: content type,
/// disposition and CSP. Every one must also forbid sniffing.
fn rendering(response: &reqwest::Response) -> (String, String, Option<String>) {
    let headers = response.headers();
    assert_eq!(headers["x-content-type-options"], "nosniff");
    let text = |name: header::HeaderName| headers.get(name).map(|v| v.to_str().unwrap().to_string());
    (
        text(header::CONTENT_TYPE).unwrap(),
        text(header::CONTENT_DISPOSITION).unwrap(),
        text(header::CONTENT_SECURITY_POLICY),
    )
}

fn attachment(name: &str) -> String {
    format!("attachment; filename=\"{name}\"; filename*=UTF-8''{name}")
}

#[tokio::test]
#[ignore = "needs Silo; run scripts/e2e.sh"]
async fn inline_downloads_only_render_passive_types() {
    let fx = Fixture::new().await;
    let active = [
        ("page.html", Some("text/html")),
        ("upper.html", Some("TEXT/HTML; charset=utf-8")),
        ("page.xhtml", Some("application/xhtml+xml")),
        ("feed.xml", Some("text/xml")),
        ("app.js", Some("application/javascript")),
        ("untyped", None),
    ];
    let passive = [
        ("pic.png", "image/png"),
        ("doc.pdf", "application/pdf"),
        ("clip.mp4", "video/mp4"),
        ("song.mp3", "audio/mpeg"),
        ("note.txt", "text/plain; charset=utf-8"),
    ];
    for (key, content_type) in active {
        fx.put_typed(key, content_type, ACTIVE).await;
    }
    for (key, content_type) in passive {
        fx.put_typed(key, Some(content_type), ACTIVE).await;
    }
    fx.put_typed("pic.svg", Some("image/svg+xml"), ACTIVE).await;
    let server = fx.server().await;
    let bucket = fx.bucket.as_str();
    let inline = |key: &str, content_type: Option<&str>| {
        let override_type = content_type.map(|t| format!("&contentType={}", urlencode(t))).unwrap_or_default();
        let path = server.bucket_path(
            "download",
            bucket,
            &format!("/object?key={}&disposition=inline{override_type}", urlencode(key)),
        );
        server.http.get(server.url(&path))
    };

    // Stored active content never renders on the app's origin, however its
    // type is spelled, yet its bytes still download intact.
    for (key, _) in active {
        let response = inline(key, None).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{key}");
        assert_eq!(rendering(&response), (OCTET_STREAM.into(), attachment(key), None), "{key}");
        assert_eq!(response.bytes().await.unwrap().as_ref(), ACTIVE, "{key}");
    }
    // A ranged read, as media seeking sends, is held to the same rule.
    let response = inline("page.html", None).header(header::RANGE, "bytes=0-5").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(rendering(&response), (OCTET_STREAM.into(), attachment("page.html"), None));
    assert_eq!(response.bytes().await.unwrap().as_ref(), &ACTIVE[..6]);

    for (key, content_type) in passive {
        let response = inline(key, None).send().await.unwrap();
        assert_eq!(rendering(&response), (content_type.into(), "inline".into(), None), "{key}");
    }
    let response = inline("pic.svg", None).send().await.unwrap();
    assert_eq!(rendering(&response), ("image/svg+xml".into(), "inline".into(), Some(SVG_CSP.into())));

    // The `contentType` override passes the same allowlist: it cannot make a
    // passive object active, and the CSP follows the type actually served.
    for override_type in ["text/html", "TEXT/HTML", "application/xhtml+xml", "text/html; charset=utf-8"] {
        let response = inline("note.txt", Some(override_type)).send().await.unwrap();
        assert_eq!(
            rendering(&response),
            (OCTET_STREAM.into(), attachment("note.txt"), None),
            "{override_type}"
        );
    }
    let response = inline("page.html", Some("text/plain")).send().await.unwrap();
    assert_eq!(rendering(&response), ("text/plain".into(), "inline".into(), None));
    let response = inline("page.html", Some("image/svg+xml")).send().await.unwrap();
    assert_eq!(rendering(&response), ("image/svg+xml".into(), "inline".into(), Some(SVG_CSP.into())));
    // A malformed override is ignored, not forwarded: the stored HTML type
    // decides, and nothing is injected into the response headers.
    let response = inline("page.html", Some("image/png\r\nx-injected: 1")).send().await.unwrap();
    assert!(response.headers().get("x-injected").is_none());
    assert_eq!(rendering(&response), (OCTET_STREAM.into(), attachment("page.html"), None));

    // A plain download is an attachment and keeps the stored type.
    let response = server.download(bucket, "page.html", None).await;
    assert_eq!(rendering(&response), ("text/html".into(), attachment("page.html"), None));
    drop(server);
    fx.cleanup().await;
}

#[tokio::test]
#[ignore = "needs Silo; run scripts/e2e.sh"]
async fn api_routing_failures_are_json() {
    let fx = Fixture::new().await;
    let server = fx.server().await;
    let bucket = fx.bucket.as_str();
    let objects = server.bucket_path("objects", bucket, "");

    // Unknown API paths are JSON 404s, never the SPA's index.html.
    let not_found = (StatusCode::NOT_FOUND, json!({ "error": "Not found" }));
    let unknown = format!("{objects}/nope");
    for path in ["/api", "/api/", "/api/nope", "/api/objects", "/api/objects/1", "/api/auth/nope/deeper", &unknown] {
        assert_eq!(server.get_json(path).await, not_found, "GET {path}");
        assert_eq!(server.post_json(path, json!({})).await, not_found, "POST {path}");
    }

    // A known path with the wrong method is a JSON 405.
    let not_allowed = (StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed" }));
    for request in [
        server.http.delete(server.url("/api/health")),
        server.http.put(server.url(&objects)),
        server.http.get(server.url(&format!("{objects}/batch-delete"))),
        server.http.post(server.url(&server.bucket_path("download", bucket, "/object?key=a"))),
    ] {
        assert_eq!(send_json(request).await, not_allowed);
    }

    // Bad route parameters.
    let (status, body) = server.get_json(&format!("/api/objects/abc/{bucket}")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["error"].as_str().unwrap().starts_with("Invalid request: "), "{body}");
    assert_eq!(
        server.get_json(&format!("/api/objects/0/{bucket}")).await,
        (StatusCode::BAD_REQUEST, json!({ "error": "Valid connection ID is required" }))
    );
    assert_eq!(
        server.get_json(&format!("/api/objects/{}/{bucket}", server.connection + 1000)).await,
        (StatusCode::NOT_FOUND, json!({ "error": "Connection not found" }))
    );

    // Bodies that are not the expected JSON are 422s with a JSON error.
    let batch_delete = server.url(&format!("{objects}/batch-delete"));
    for request in [
        server.http.post(&batch_delete).header(header::CONTENT_TYPE, "application/json").body("{"),
        server.http.post(&batch_delete).body(r#"{"keys": []}"#),
        server.http.post(&batch_delete).json(&json!({ "keys": "a.txt" })),
        server.http.post(server.url(&format!("{objects}/batch-copy"))).json(&json!({ "operations": [{}] })),
    ] {
        let (status, body) = send_json(request).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert!(body["error"].as_str().unwrap().starts_with("Invalid request: "), "{body}");
    }

    // A body past the 32 MiB request limit is a JSON 413. One byte over, so
    // the server has read it all when it answers and the write cannot break.
    let oversized = || vec![b' '; 32 * 1024 * 1024 + 1];
    let path = server.bucket_path("upload", bucket, "/single?key=huge.bin");
    for request in [
        server.http.post(server.url(&path)).body(oversized()),
        server.http.post(&batch_delete).header(header::CONTENT_TYPE, "application/json").body(oversized()),
    ] {
        let (status, body) = send_json(request).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
        assert!(body["error"].is_string(), "{body}");
    }
    assert_eq!(fx.keys().await, Vec::<String>::new());

    // Without a valid session every protected path, known or not, is a 401
    // that clears the cookie; only the exempt endpoints answer.
    let anonymous = reqwest::Client::new();
    let forged = "s3browser_auth_token=e30.e30.forged";
    for (path, cookie) in [("/api/nope", None), (objects.as_str(), None), (objects.as_str(), Some(forged))] {
        let mut request = anonymous.get(server.url(path));
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let response = request.send().await.unwrap();
        let cleared = response.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
        assert!(cleared.starts_with("s3browser_auth_token=\"\"") && cleared.contains("Max-Age=0"), "{cleared}");
        assert_eq!(
            send_json_response(response).await,
            (StatusCode::UNAUTHORIZED, json!({ "error": "Not authenticated", "code": "NotAuthenticated" })),
            "{path}"
        );
    }
    let (status, _) = send_json(anonymous.get(server.url("/api/health"))).await;
    assert_eq!(status, StatusCode::OK);

    // Outside `/api/` is the SPA, except missing static files.
    for path in ["/", "/connection/1/browse/b/", "/connection/1/preview/b/data.json", "/api-docs"] {
        let response = anonymous.get(server.url(path)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8", "{path}");
    }
    for path in ["/assets/missing.js", "/missing.ico"] {
        let response = anonymous.get(server.url(path)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    drop(server);
    fx.cleanup().await;
}

#[tokio::test]
#[ignore = "needs Silo; run scripts/e2e.sh"]
async fn batch_errors_name_each_failed_object() {
    let fx = Fixture::with_object_lock().await;
    let held = fx.put_held("held.txt", b"held").await;
    for key in ["a.txt", "b.txt", "c.txt"] {
        fx.put(key, key.as_bytes().to_vec()).await;
    }
    let server = fx.server().await;
    let bucket = fx.bucket.as_str();
    let post = {
        let server = &server;
        move |rest: &str, body: Value| {
            let path = server.bucket_path("objects", bucket, rest);
            async move { server.post_json(&path, body).await }
        }
    };

    // Request-level problems refuse the whole batch before any S3 call, even
    // when earlier entries are valid.
    let operations = |n: usize| -> Vec<Value> {
        (0..n).map(|i| json!({ "sourceKey": format!("k{i}"), "destinationKey": format!("d{i}") })).collect()
    };
    let keys: Vec<Value> = (0..1001).map(|i| json!({ "key": format!("k{i}") })).collect();
    let cases = [
        ("/batch-delete", json!({}), "Keys must be a non-empty array"),
        ("/batch-delete", json!({ "keys": [] }), "Keys must be a non-empty array"),
        ("/batch-delete", json!({ "keys": [{ "key": "dir/" }, { "key": "" }, {}] }), "No valid file keys provided"),
        ("/batch-delete", json!({ "keys": keys }), "Cannot delete more than 1000 objects at once"),
        ("/batch-copy", json!({ "operations": [] }), "Operations must be a non-empty array"),
        ("/batch-copy", json!({ "operations": operations(1001) }), "Cannot copy more than 1000 objects at once"),
        ("/batch-move", json!({ "operations": operations(1001) }), "Cannot move more than 1000 objects at once"),
        (
            "/batch-copy",
            json!({ "operations": [{ "sourceKey": "a.txt", "destinationKey": "" }] }),
            "Each operation must have sourceKey and destinationKey",
        ),
        (
            "/batch-move",
            json!({ "operations": [{ "sourceKey": "a.txt", "destinationKey": "a.txt" }] }),
            "sourceKey and destinationKey must differ for operation with key \"a.txt\"",
        ),
        (
            "/batch-copy",
            json!({ "operations": [
                { "sourceKey": "a.txt", "destinationKey": "ok/a.txt" },
                { "sourceKey": "a.txt", "destinationKey": "../a.txt" },
            ] }),
            "Invalid destinationKey \"../a.txt\": Invalid object key",
        ),
        (
            "/batch-move",
            json!({ "operations": [
                { "sourceKey": "a.txt", "destinationKey": "ok/a.txt" },
                { "sourceKey": "/a.txt", "destinationKey": "ok/b.txt" },
            ] }),
            "Invalid sourceKey \"/a.txt\": Invalid object key",
        ),
    ];
    for (rest, body, error) in cases {
        assert_eq!(post(rest, body).await, (StatusCode::BAD_REQUEST, json!({ "error": error })), "{rest} {error}");
    }
    assert_eq!(fx.keys().await, ["a.txt", "b.txt", "c.txt", "held.txt"]);

    // Per-object failures are reported one by one with a stable message; the
    // upstream S3 text stays in the server log.
    let (status, body) = post(
        "/batch-copy",
        json!({ "operations": [
            { "sourceKey": "a.txt", "destinationKey": "copies/a.txt" },
            { "sourceKey": "a.txt", "destinationKey": "copies/old.txt", "versionId": "8a5c3b7e-0d2f-4e1a-9b6c-3f4d5e6a7b8c" },
            { "sourceKey": "missing.txt", "destinationKey": "copies/missing.txt" },
        ] }),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({
                "successful": ["a.txt"],
                "errors": [
                    { "sourceKey": "a.txt", "message": "Copy failed" },
                    { "sourceKey": "missing.txt", "message": "Copy failed" },
                ],
            })
        )
    );

    // A move whose delete is refused (the held version) reports that its
    // copy now exists; one whose copy fails reports no destination.
    let (status, body) = post(
        "/batch-move",
        json!({ "operations": [
            { "sourceKey": "held.txt", "destinationKey": "moved/held.txt", "versionId": held },
            { "sourceKey": "missing.txt", "destinationKey": "moved/missing.txt" },
            { "sourceKey": "b.txt", "destinationKey": "moved/b.txt" },
        ] }),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({
                "successful": ["b.txt"],
                "errors": [
                    {
                        "sourceKey": "held.txt",
                        "destinationKey": "moved/held.txt",
                        "message": "Delete failed after successful copy; destination created",
                    },
                    { "sourceKey": "missing.txt", "message": "Copy failed" },
                ],
            })
        )
    );
    assert_eq!(fx.get("moved/held.txt").await, b"held");
    assert_eq!(fx.get("held.txt").await, b"held");

    // The single move reports the same half-done state as a 500.
    let (status, body) = post(
        "/move",
        json!({ "sourceKey": "held.txt", "destinationKey": "again/held.txt", "versionId": held }),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({
                "success": false,
                "message": "Move failed: copy succeeded but source delete failed. Destination key now has the data \
                            and the source still exists; retry the delete or remove the destination to recover.",
                "destinationKey": "again/held.txt",
                "error": "Delete failed",
            })
        )
    );

    // DeleteObjects refuses the held version and still deletes the rest.
    // Without a version the delete is a delete marker, named in the result.
    let (status, body) = post(
        "/batch-delete",
        json!({ "keys": [{ "key": "held.txt", "versionId": held }, { "key": "c.txt" }, { "key": "dir/" }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let deleted = body["deleted"].as_array().unwrap();
    assert_eq!(deleted.len(), 1, "{body}");
    assert_eq!(deleted[0]["key"], "c.txt", "{body}");
    assert!(deleted[0]["versionId"].as_str().is_some_and(|v| !v.is_empty()), "{body}");
    let errors = body["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 1, "{body}");
    assert_eq!(errors[0]["key"], "held.txt", "{body}");
    let message = errors[0]["message"].as_str().unwrap();
    assert!(!message.is_empty() && message != "Unknown error", "{body}");
    assert_eq!(fx.get("held.txt").await, b"held");

    fx.release("held.txt", &held).await;
    drop(server);
    fx.cleanup().await;
}

/// Needs no S3, so it runs with the unit tests too.
#[test]
fn second_server_is_locked_out() {
    let home = TempDir::new().unwrap();
    let start = |port: u16| {
        Command::new(env!("CARGO_BIN_EXE_s3browser"))
            .args(["server", "--bind", &format!("127.0.0.1:{port}")])
            .current_dir(env!("CARGO_TARGET_TMPDIR"))
            .env_clear()
            .env("HOME", home.path())
            .env("S3BROWSER_LOGIN_PASSWORD", PASSWORD)
            .env("S3BROWSER_ENCRYPTION_KEY", ENCRYPTION_KEY)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    };
    let mut first = start(free_port());
    // The database is opened after the lock is taken.
    let db = home.path().join(".s3browser").join("s3browser.db");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !db.exists() {
        assert!(Instant::now() < deadline, "first server did not create its database");
        std::thread::sleep(Duration::from_millis(50));
    }
    let second = start(free_port()).wait_with_output().unwrap();
    first.kill().unwrap();
    first.wait().unwrap();
    assert!(!second.status.success());
    assert!(stderr(&second).contains("Another s3browser process is already running"), "{}", stderr(&second));
}
