from fastapi import APIRouter, Depends

from s3browser.dependencies import get_s3_context
from s3browser.s3 import S3Context, error_code, error_message, http_status_code, require_bucket
from s3browser.utils import isoformat_z

router = APIRouter(prefix="/api/bucket", tags=["bucket"])

_ENCRYPTION_NOT_SUPPORTED_CODES = {
    "NotImplemented",
    "NotImplementedException",
    "NotImplementedError",
    "UnsupportedOperation",
}

_LIFECYCLE_NOT_CONFIGURED_CODES = {"NoSuchLifecycleConfiguration", "NotFound"}


def _is_encryption_not_supported(error: object) -> bool:
    if http_status_code(error) == 501:
        return True
    if error_code(error) in _ENCRYPTION_NOT_SUPPORTED_CODES:
        return True
    message = error_message(error).lower()
    return "not implemented" in message or "notimplemented" in message or "unimplemented" in message


def _is_lifecycle_not_configured(error: object) -> bool:
    status = http_status_code(error)
    code = error_code(error)
    if status == 404 and code in _LIFECYCLE_NOT_CONFIGURED_CODES:
        return True
    message = error_message(error).lower()
    if status == 404 and not code and "lifecycle" in message:
        return True
    return "nosuchlifecycleconfiguration" in message or "no such lifecycle configuration" in message


@router.get("/{connection_id}/{bucket}/info")
async def bucket_info(context: S3Context = Depends(get_s3_context)) -> dict[str, object]:
    bucket = require_bucket(context)
    client = context.client
    result: dict[str, object] = {
        "versioning": None,
        "encryption": None,
        "encryptionError": None,
        "lifecycleError": None,
        "lifecycleRules": [],
    }
    try:
        versioning = await client.get_bucket_versioning(Bucket=bucket)
        result["versioning"] = {
            "status": versioning.get("Status"),
            "mfaDelete": versioning.get("MFADelete"),
        }
    except Exception as error:
        print(f"Failed to get bucket versioning: {error}")
    try:
        encryption = await client.get_bucket_encryption(Bucket=bucket)
        rules = encryption.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
        if rules:
            default_rule = rules[0].get("ApplyServerSideEncryptionByDefault", {})
            if default_rule:
                result["encryption"] = {
                    "algorithm": default_rule.get("SSEAlgorithm"),
                    "kmsKeyId": default_rule.get("KMSMasterKeyID"),
                }
    except Exception as error:
        text = str(error)
        if "ServerSideEncryptionConfigurationNotFoundError" in text:
            pass
        elif _is_encryption_not_supported(error):
            result["encryptionError"] = "Not supported by this storage provider"
        else:
            print(f"Failed to get bucket encryption: {error}")
            result["encryptionError"] = text
    try:
        lifecycle = await client.get_bucket_lifecycle_configuration(Bucket=bucket)
        rules_out: list[dict[str, object]] = []
        for rule in lifecycle.get("Rules", []):
            expiration = rule.get("Expiration")
            transitions = rule.get("Transitions")
            noncurrent = rule.get("NoncurrentVersionExpiration")
            abort_upload = rule.get("AbortIncompleteMultipartUpload")
            item: dict[str, object] = {
                "id": rule.get("ID"),
                "status": rule.get("Status") or "Unknown",
                "prefix": rule.get("Filter", {}).get("Prefix"),
            }
            if expiration:
                item["expiration"] = {
                    "days": expiration.get("Days"),
                    "date": isoformat_z(expiration.get("Date")),
                    "expiredObjectDeleteMarker": expiration.get("ExpiredObjectDeleteMarker"),
                }
            if transitions:
                item["transitions"] = [
                    {
                        "days": t.get("Days"),
                        "date": isoformat_z(t.get("Date")),
                        "storageClass": t.get("StorageClass") or "Unknown",
                    }
                    for t in transitions
                ]
            if noncurrent:
                item["noncurrentVersionExpiration"] = {
                    "days": noncurrent.get("NoncurrentDays"),
                    "newerNoncurrentVersions": noncurrent.get("NewerNoncurrentVersions"),
                }
            if abort_upload:
                item["abortIncompleteMultipartUpload"] = {
                    "daysAfterInitiation": abort_upload.get("DaysAfterInitiation")
                }
            rules_out.append(item)
        result["lifecycleRules"] = rules_out
    except Exception as error:
        if not _is_lifecycle_not_configured(error):
            print(f"Failed to get bucket lifecycle: {error}")
            result["lifecycleError"] = str(error)
    return result
