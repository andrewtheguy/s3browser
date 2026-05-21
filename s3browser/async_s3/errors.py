from __future__ import annotations

import xml.etree.ElementTree as ET
from collections.abc import Mapping

_STATUS_FALLBACK_CODE = {
    301: "PermanentRedirect",
    400: "BadRequest",
    403: "AccessDenied",
    404: "NotFound",
    405: "MethodNotAllowed",
    409: "Conflict",
    411: "MissingContentLength",
    412: "PreconditionFailed",
    416: "InvalidRange",
    501: "NotImplemented",
    503: "ServiceUnavailable",
}


class S3Error(Exception):
    def __init__(
        self,
        *,
        code: str,
        message: str,
        status: int,
        headers: Mapping[str, str] | None = None,
        request_id: str | None = None,
        resource: str | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status
        self.headers: dict[str, str] = dict(headers) if headers else {}
        self.request_id = request_id
        self.resource = resource

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


def parse_error_response(
    status: int, body: bytes, headers: Mapping[str, str] | None = None
) -> S3Error:
    code = _STATUS_FALLBACK_CODE.get(status, "Error")
    message = f"HTTP {status}"
    request_id: str | None = None
    resource: str | None = None
    text = body.decode("utf-8", errors="replace").strip() if body else ""
    if text.startswith("<"):
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            root = None
        if root is not None:
            element = root if root.tag.endswith("Error") else root.find(".//Error")
            target = element if element is not None else root
            code_el = target.find("Code")
            message_el = target.find("Message")
            request_id_el = target.find("RequestId")
            resource_el = target.find("Resource")
            if code_el is not None and code_el.text:
                code = code_el.text.strip()
            if message_el is not None and message_el.text:
                message = message_el.text.strip()
            if request_id_el is not None and request_id_el.text:
                request_id = request_id_el.text.strip()
            if resource_el is not None and resource_el.text:
                resource = resource_el.text.strip()
    elif text:
        message = text[:500]
    return S3Error(
        code=code,
        message=message,
        status=status,
        headers=headers,
        request_id=request_id,
        resource=resource,
    )
