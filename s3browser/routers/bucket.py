from fastapi import APIRouter, Depends

from s3browser.dependencies import get_s3_context
from s3browser.s3 import S3Context, require_bucket
from s3browser.utils import isoformat_z

router = APIRouter(prefix="/api/bucket", tags=["bucket"])


def _is_encryption_not_supported(error: object) -> bool:
    text = str(error).lower()
    return "notimplemented" in text or "not implemented" in text or "unsupportedoperation" in text


def _is_lifecycle_not_configured(error: object) -> bool:
    text = str(error).lower()
    return "nosuchlifecycleconfiguration" in text or "no such lifecycle configuration" in text


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
