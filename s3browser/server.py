from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import Scope

from s3browser.auth import AUTH_COOKIE_NAME, create_auth_token, verify_auth_token
from s3browser.config import (
    SEARCH_WHITELIST_ENV_VAR,
    get_presigned_url_ttl_options,
    get_search_whitelist_hosts,
)
from s3browser.db import close_db, get_db, get_index_db
from s3browser.lock import FileLock
from s3browser.paths import SERVER_LOCK_FILE
from s3browser.routers import auth, bucket, config, download, objects, upload

_server_lock: FileLock | None = None

AUTH_EXEMPT_PATHS = {
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/status",
    "/api/config",
    "/api/config/",
    "/api/health",
}


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global _server_lock
    try:
        get_presigned_url_ttl_options()
        _server_lock = FileLock(SERVER_LOCK_FILE)
        _server_lock.acquire()
        get_db()
        get_index_db()
        print("Database initialized successfully")
        whitelist_count = len(get_search_whitelist_hosts())
        if whitelist_count == 0:
            print(
                f"{SEARCH_WHITELIST_ENV_VAR} is unset or empty: "
                "search and indexing are disabled for all connections"
            )
        else:
            print(
                f"{SEARCH_WHITELIST_ENV_VAR}: {whitelist_count} host(s) "
                "whitelisted for search/indexing"
            )
        yield
    finally:
        close_db()
        if _server_lock is not None:
            _server_lock.release()
            _server_lock = None


app = FastAPI(title="s3browser", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict):
        content = (
            exc.detail
            if "error" in exc.detail
            else {"error": exc.detail.get("detail", "Request failed"), **exc.detail}
        )
    else:
        content = {"error": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content=content, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=422, content={"error": "Invalid request", "details": exc.errors()}
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    print(f"Unhandled error: {exc}")
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


@app.middleware("http")
async def api_auth_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    path = request.url.path
    protected_api = path.startswith("/api/") and path not in AUTH_EXEMPT_PATHS
    if protected_api and not verify_auth_token(request.cookies.get(AUTH_COOKIE_NAME)):
        response = JSONResponse(status_code=401, content={"error": "Not authenticated"})
        response.delete_cookie(AUTH_COOKIE_NAME, path="/")
        return response
    response = await call_next(request)
    if protected_api:
        response.set_cookie(
            AUTH_COOKIE_NAME,
            create_auth_token(),
            httponly=True,
            secure=request.url.scheme == "https",
            samesite="lax",
            path="/",
        )
    return response


app.include_router(auth.router)
app.include_router(objects.router)
app.include_router(upload.router)
app.include_router(download.router)
app.include_router(bucket.router)
app.include_router(config.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                if path.startswith("assets/") or Path(path).suffix:
                    raise
                return await super().get_response("index.html", scope)
            raise


def _static_directory() -> Path | None:
    package_static = Path(__file__).resolve().parent / "static"
    if (package_static / "index.html").is_file():
        return package_static
    local_dist = Path.cwd() / "dist"
    if (local_dist / "index.html").is_file():
        return local_dist
    return None


static_dir = _static_directory()
if static_dir is not None:
    app.mount("/", SPAStaticFiles(directory=static_dir, html=True), name="frontend")


def run(host: str | None = None, port: int = 8170, reload: bool = False) -> None:
    bind_host = host or "0.0.0.0"
    display_host = (
        "localhost"
        if bind_host == "0.0.0.0"
        else f"[{bind_host}]"
        if ":" in bind_host
        else bind_host
    )
    print(f"S3 Browser running at http://{display_host}:{port}")
    uvicorn.run("s3browser.server:app", host=bind_host, port=port, reload=reload)
