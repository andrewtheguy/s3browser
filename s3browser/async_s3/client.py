from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote, urlparse

import httpx

from s3browser.async_s3.errors import S3Error, parse_error_response
from s3browser.async_s3.signing import SigV4Signer, canonical_query_string
from s3browser.async_s3.xml_parsing import (
    BucketEncryption,
    BucketSummary,
    BucketVersioning,
    CompleteMultipartResult,
    CopyResult,
    DeleteObjectsResult,
    KeyToDelete,
    LifecycleRule,
    ListObjectsResult,
    ListVersionsResult,
    MultipartPart,
    build_complete_multipart_body,
    build_delete_objects_body,
    parse_bucket_encryption,
    parse_bucket_lifecycle,
    parse_bucket_location,
    parse_bucket_versioning,
    parse_complete_multipart,
    parse_copy_object,
    parse_create_multipart,
    parse_delete_objects,
    parse_list_buckets,
    parse_list_object_versions,
    parse_list_objects_v2,
    parse_upload_part_copy,
)

_DEFAULT_TIMEOUT = httpx.Timeout(30.0, read=300.0, connect=10.0)
_STREAM_CHUNK_SIZE = 64 * 1024


def _empty_sha256() -> str:
    return hashlib.sha256(b"").hexdigest()


@dataclass
class HeadObjectResult:
    status: int
    headers: httpx.Headers
    content_length: int | None
    content_type: str | None
    etag: str | None
    last_modified: str | None
    version_id: str | None
    storage_class: str | None
    server_side_encryption: str | None
    sse_kms_key_id: str | None
    sse_customer_algorithm: str | None
    cache_control: str | None
    content_disposition: str | None
    content_encoding: str | None
    accept_ranges: str | None
    metadata: dict[str, str]
    checksum_sha256: str | None
    checksum_sha1: str | None
    checksum_crc32: str | None
    checksum_crc32c: str | None
    checksum_crc64nvme: str | None
    checksum_type: str | None


@dataclass
class HeadBucketResult:
    status: int
    region: str | None
    headers: httpx.Headers


@dataclass
class GetObjectResponse:
    status: int
    headers: httpx.Headers
    content_length: int | None
    content_type: str | None
    content_range: str | None
    accept_ranges: str | None
    etag: str | None
    last_modified: str | None
    version_id: str | None
    aiter_bytes: Callable[[], AsyncIterator[bytes]]
    aclose: Callable[[], Awaitable[None]]


@dataclass
class PutObjectResult:
    etag: str | None
    version_id: str | None
    server_side_encryption: str | None


def _extract_user_metadata(headers: httpx.Headers) -> dict[str, str]:
    return {
        key[len("x-amz-meta-") :]: value
        for key, value in headers.items()
        if key.lower().startswith("x-amz-meta-")
    }


def _opt_int(headers: httpx.Headers, name: str) -> int | None:
    value = headers.get(name)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _opt(headers: httpx.Headers, name: str) -> str | None:
    return headers.get(name)


class S3Client:
    def __init__(
        self,
        *,
        access_key_id: str,
        secret_access_key: str,
        region: str,
        endpoint_url: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.region = region
        self.endpoint_url = endpoint_url.rstrip("/") if endpoint_url else None
        self._signer = SigV4Signer(
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            region=region,
        )
        if http_client is None:
            self._client = httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT, follow_redirects=False)
            self._owns_client = True
        else:
            self._client = http_client
            self._owns_client = False

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> S3Client:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    def _host(self) -> str:
        if self.endpoint_url:
            return urlparse(self.endpoint_url).netloc
        return f"s3.{self.region}.amazonaws.com"

    def _scheme(self) -> str:
        if self.endpoint_url:
            return urlparse(self.endpoint_url).scheme or "https"
        return "https"

    def _build_canonical_uri(self, bucket: str | None, key: str | None) -> str:
        if bucket is None:
            return "/"
        if key is None or key == "":
            return f"/{bucket}"
        encoded = "/".join(quote(segment, safe="~") for segment in key.split("/"))
        return f"/{bucket}/{encoded}"

    def _wire_url(self, canonical_uri: str, canonical_query: str) -> str:
        base = f"{self._scheme()}://{self._host()}{canonical_uri}"
        return f"{base}?{canonical_query}" if canonical_query else base

    def _sign(
        self,
        *,
        method: str,
        canonical_uri: str,
        canonical_query: str,
        extra_headers: Mapping[str, str] | None,
        payload_sha256: str,
    ) -> dict[str, str]:
        headers: dict[str, str] = {"host": self._host()}
        if extra_headers:
            for name, value in extra_headers.items():
                headers[name.lower()] = value
        return self._signer.sign_request(
            method=method,
            canonical_uri=canonical_uri,
            canonical_query=canonical_query,
            headers=headers,
            payload_sha256=payload_sha256,
            now=datetime.now(UTC),
        )

    async def _request(
        self,
        *,
        method: str,
        bucket: str | None = None,
        key: str | None = None,
        query: Mapping[str, str] | None = None,
        body: bytes = b"",
        extra_headers: Mapping[str, str] | None = None,
        ok_statuses: tuple[int, ...] | None = None,
    ) -> httpx.Response:
        canonical_uri = self._build_canonical_uri(bucket, key)
        canonical_query = canonical_query_string(dict(query) if query else {})
        payload_sha256 = hashlib.sha256(body).hexdigest() if body else _empty_sha256()
        signed = self._sign(
            method=method,
            canonical_uri=canonical_uri,
            canonical_query=canonical_query,
            extra_headers=extra_headers,
            payload_sha256=payload_sha256,
        )
        url = self._wire_url(canonical_uri, canonical_query)
        response = await self._client.request(method, url, content=body, headers=signed)
        accept = ok_statuses if ok_statuses is not None else tuple(range(200, 300))
        if response.status_code in accept or 200 <= response.status_code < 300:
            return response
        raise parse_error_response(response.status_code, response.content, response.headers)

    async def list_objects_v2(
        self,
        bucket: str,
        *,
        prefix: str = "",
        delimiter: str | None = None,
        max_keys: int = 1000,
        continuation_token: str | None = None,
        start_after: str | None = None,
    ) -> ListObjectsResult:
        query: dict[str, str] = {"list-type": "2", "max-keys": str(max_keys)}
        if prefix:
            query["prefix"] = prefix
        if delimiter:
            query["delimiter"] = delimiter
        if continuation_token:
            query["continuation-token"] = continuation_token
        if start_after:
            query["start-after"] = start_after
        response = await self._request(method="GET", bucket=bucket, query=query)
        return parse_list_objects_v2(response.content)

    async def list_object_versions(
        self,
        bucket: str,
        *,
        prefix: str = "",
        delimiter: str | None = None,
        max_keys: int = 1000,
        key_marker: str | None = None,
        version_id_marker: str | None = None,
    ) -> ListVersionsResult:
        query: dict[str, str] = {"versions": "", "max-keys": str(max_keys)}
        if prefix:
            query["prefix"] = prefix
        if delimiter:
            query["delimiter"] = delimiter
        if key_marker:
            query["key-marker"] = key_marker
        if version_id_marker:
            query["version-id-marker"] = version_id_marker
        response = await self._request(method="GET", bucket=bucket, query=query)
        return parse_list_object_versions(response.content)

    async def list_buckets(self) -> list[BucketSummary]:
        response = await self._request(method="GET")
        return parse_list_buckets(response.content)

    async def head_bucket(self, bucket: str) -> HeadBucketResult:
        try:
            response = await self._request(method="HEAD", bucket=bucket)
        except S3Error as error:
            if "x-amz-bucket-region" in error.headers:
                return HeadBucketResult(
                    status=error.status,
                    region=error.headers.get("x-amz-bucket-region"),
                    headers=httpx.Headers(error.headers),
                )
            raise
        return HeadBucketResult(
            status=response.status_code,
            region=response.headers.get("x-amz-bucket-region"),
            headers=response.headers,
        )

    async def head_object(
        self,
        bucket: str,
        key: str,
        *,
        version_id: str | None = None,
        checksum_mode: bool = False,
    ) -> HeadObjectResult:
        query: dict[str, str] = {}
        if version_id:
            query["versionId"] = version_id
        extra: dict[str, str] = {}
        if checksum_mode:
            extra["x-amz-checksum-mode"] = "ENABLED"
        response = await self._request(
            method="HEAD", bucket=bucket, key=key, query=query, extra_headers=extra
        )
        headers = response.headers
        return HeadObjectResult(
            status=response.status_code,
            headers=headers,
            content_length=_opt_int(headers, "content-length"),
            content_type=_opt(headers, "content-type"),
            etag=_opt(headers, "etag"),
            last_modified=_opt(headers, "last-modified"),
            version_id=_opt(headers, "x-amz-version-id"),
            storage_class=_opt(headers, "x-amz-storage-class"),
            server_side_encryption=_opt(headers, "x-amz-server-side-encryption"),
            sse_kms_key_id=_opt(headers, "x-amz-server-side-encryption-aws-kms-key-id"),
            sse_customer_algorithm=_opt(headers, "x-amz-server-side-encryption-customer-algorithm"),
            cache_control=_opt(headers, "cache-control"),
            content_disposition=_opt(headers, "content-disposition"),
            content_encoding=_opt(headers, "content-encoding"),
            accept_ranges=_opt(headers, "accept-ranges"),
            metadata=_extract_user_metadata(headers),
            checksum_sha256=_opt(headers, "x-amz-checksum-sha256"),
            checksum_sha1=_opt(headers, "x-amz-checksum-sha1"),
            checksum_crc32=_opt(headers, "x-amz-checksum-crc32"),
            checksum_crc32c=_opt(headers, "x-amz-checksum-crc32c"),
            checksum_crc64nvme=_opt(headers, "x-amz-checksum-crc64nvme"),
            checksum_type=_opt(headers, "x-amz-checksum-type"),
        )

    async def get_object(
        self,
        bucket: str,
        key: str,
        *,
        version_id: str | None = None,
        range_header: str | None = None,
    ) -> GetObjectResponse:
        query: dict[str, str] = {}
        if version_id:
            query["versionId"] = version_id
        extra: dict[str, str] = {}
        if range_header:
            extra["range"] = range_header
        canonical_uri = self._build_canonical_uri(bucket, key)
        canonical_query = canonical_query_string(query)
        signed = self._sign(
            method="GET",
            canonical_uri=canonical_uri,
            canonical_query=canonical_query,
            extra_headers=extra,
            payload_sha256=_empty_sha256(),
        )
        url = self._wire_url(canonical_uri, canonical_query)
        request = self._client.build_request("GET", url, headers=signed)
        response = await self._client.send(request, stream=True)
        if not 200 <= response.status_code < 300:
            body = await response.aread()
            headers = dict(response.headers)
            await response.aclose()
            raise parse_error_response(response.status_code, body, headers)

        async def aiter_bytes() -> AsyncIterator[bytes]:
            try:
                async for chunk in response.aiter_bytes(_STREAM_CHUNK_SIZE):
                    yield chunk
            finally:
                await response.aclose()

        async def aclose() -> None:
            await response.aclose()

        return GetObjectResponse(
            status=response.status_code,
            headers=response.headers,
            content_length=_opt_int(response.headers, "content-length"),
            content_type=_opt(response.headers, "content-type"),
            content_range=_opt(response.headers, "content-range"),
            accept_ranges=_opt(response.headers, "accept-ranges"),
            etag=_opt(response.headers, "etag"),
            last_modified=_opt(response.headers, "last-modified"),
            version_id=_opt(response.headers, "x-amz-version-id"),
            aiter_bytes=aiter_bytes,
            aclose=aclose,
        )

    async def get_bucket_location(self, bucket: str) -> str | None:
        response = await self._request(method="GET", bucket=bucket, query={"location": ""})
        return parse_bucket_location(response.content)

    async def get_bucket_versioning(self, bucket: str) -> BucketVersioning:
        response = await self._request(method="GET", bucket=bucket, query={"versioning": ""})
        return parse_bucket_versioning(response.content)

    async def get_bucket_encryption(self, bucket: str) -> BucketEncryption:
        response = await self._request(method="GET", bucket=bucket, query={"encryption": ""})
        return parse_bucket_encryption(response.content)

    async def get_bucket_lifecycle_configuration(self, bucket: str) -> list[LifecycleRule]:
        response = await self._request(method="GET", bucket=bucket, query={"lifecycle": ""})
        return parse_bucket_lifecycle(response.content)

    async def put_object(
        self,
        bucket: str,
        key: str,
        body: bytes,
        *,
        content_type: str | None = None,
    ) -> PutObjectResult:
        extra: dict[str, str] = {}
        if content_type:
            extra["content-type"] = content_type
        response = await self._request(
            method="PUT", bucket=bucket, key=key, body=body, extra_headers=extra
        )
        return PutObjectResult(
            etag=_opt(response.headers, "etag"),
            version_id=_opt(response.headers, "x-amz-version-id"),
            server_side_encryption=_opt(response.headers, "x-amz-server-side-encryption"),
        )

    async def delete_object(
        self,
        bucket: str,
        key: str,
        *,
        version_id: str | None = None,
    ) -> dict[str, str | None]:
        query: dict[str, str] = {}
        if version_id:
            query["versionId"] = version_id
        response = await self._request(method="DELETE", bucket=bucket, key=key, query=query)
        return {
            "version_id": _opt(response.headers, "x-amz-version-id"),
            "delete_marker": _opt(response.headers, "x-amz-delete-marker"),
        }

    async def delete_objects(
        self,
        bucket: str,
        keys: list[KeyToDelete],
        *,
        quiet: bool = False,
    ) -> DeleteObjectsResult:
        body = build_delete_objects_body(keys, quiet=quiet)
        content_md5 = _content_md5(body)
        response = await self._request(
            method="POST",
            bucket=bucket,
            query={"delete": ""},
            body=body,
            extra_headers={"content-md5": content_md5, "content-type": "application/xml"},
        )
        return parse_delete_objects(response.content)

    async def copy_object(
        self,
        bucket: str,
        key: str,
        *,
        copy_source: str,
        metadata_directive: str | None = None,
    ) -> CopyResult:
        extra: dict[str, str] = {"x-amz-copy-source": copy_source}
        if metadata_directive:
            extra["x-amz-metadata-directive"] = metadata_directive
        response = await self._request(method="PUT", bucket=bucket, key=key, extra_headers=extra)
        return parse_copy_object(response.content)

    async def create_multipart_upload(
        self,
        bucket: str,
        key: str,
        *,
        content_type: str | None = None,
    ) -> str:
        extra: dict[str, str] = {}
        if content_type:
            extra["content-type"] = content_type
        response = await self._request(
            method="POST",
            bucket=bucket,
            key=key,
            query={"uploads": ""},
            extra_headers=extra,
        )
        return parse_create_multipart(response.content)

    async def upload_part(
        self,
        bucket: str,
        key: str,
        *,
        upload_id: str,
        part_number: int,
        body: bytes,
    ) -> str:
        response = await self._request(
            method="PUT",
            bucket=bucket,
            key=key,
            query={"partNumber": str(part_number), "uploadId": upload_id},
            body=body,
        )
        etag = _opt(response.headers, "etag")
        if not etag:
            raise S3Error(
                code="InternalError",
                message="UploadPart response missing ETag",
                status=response.status_code,
            )
        return etag

    async def upload_part_copy(
        self,
        bucket: str,
        key: str,
        *,
        upload_id: str,
        part_number: int,
        copy_source: str,
        copy_source_range: str | None = None,
    ) -> CopyResult:
        extra: dict[str, str] = {"x-amz-copy-source": copy_source}
        if copy_source_range:
            extra["x-amz-copy-source-range"] = copy_source_range
        response = await self._request(
            method="PUT",
            bucket=bucket,
            key=key,
            query={"partNumber": str(part_number), "uploadId": upload_id},
            extra_headers=extra,
        )
        return parse_upload_part_copy(response.content)

    async def complete_multipart_upload(
        self,
        bucket: str,
        key: str,
        *,
        upload_id: str,
        parts: list[MultipartPart],
    ) -> CompleteMultipartResult:
        body = build_complete_multipart_body(parts)
        response = await self._request(
            method="POST",
            bucket=bucket,
            key=key,
            query={"uploadId": upload_id},
            body=body,
            extra_headers={"content-type": "application/xml"},
        )
        return parse_complete_multipart(response.content)

    async def abort_multipart_upload(
        self,
        bucket: str,
        key: str,
        *,
        upload_id: str,
    ) -> None:
        await self._request(
            method="DELETE",
            bucket=bucket,
            key=key,
            query={"uploadId": upload_id},
            ok_statuses=(204,),
        )

    def generate_presigned_url(
        self,
        bucket: str,
        key: str,
        *,
        expires_in: int = 3600,
        version_id: str | None = None,
        response_content_disposition: str | None = None,
        response_content_type: str | None = None,
        method: str = "GET",
    ) -> str:
        extra: dict[str, str] = {}
        if version_id:
            extra["versionId"] = version_id
        if response_content_disposition:
            extra["response-content-disposition"] = response_content_disposition
        if response_content_type:
            extra["response-content-type"] = response_content_type
        canonical_uri = self._build_canonical_uri(bucket, key)
        return self._signer.presign(
            method=method,
            host=self._host(),
            canonical_uri=canonical_uri,
            extra_query=extra,
            expires_in=expires_in,
            now=datetime.now(UTC),
            scheme=self._scheme(),
        )


def _content_md5(body: bytes) -> str:
    import base64

    return base64.b64encode(hashlib.md5(body).digest()).decode()
