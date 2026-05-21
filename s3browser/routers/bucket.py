from fastapi import APIRouter, Depends

from s3browser.async_s3 import S3Error
from s3browser.dependencies import get_s3_context
from s3browser.s3 import S3Context, require_bucket
from s3browser.utils import isoformat_z

router = APIRouter(prefix="/api/bucket", tags=["bucket"])


def _is_encryption_not_supported(error: S3Error) -> bool:
    return error.code in {"NotImplemented", "UnsupportedOperation"}


def _is_lifecycle_not_configured(error: S3Error) -> bool:
    return error.code == "NoSuchLifecycleConfiguration"


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
        versioning = await client.get_bucket_versioning(bucket)
        result["versioning"] = {
            "status": versioning.status,
            "mfaDelete": versioning.mfa_delete,
        }
    except S3Error as error:
        if error.code != "VersioningNotConfigured":
            print(f"Failed to get bucket versioning: {error}")
    try:
        encryption = await client.get_bucket_encryption(bucket)
        if encryption.rules:
            first = encryption.rules[0]
            result["encryption"] = {
                "algorithm": first.sse_algorithm,
                "kmsKeyId": first.kms_master_key_id,
            }
    except S3Error as error:
        if error.code == "ServerSideEncryptionConfigurationNotFoundError":
            pass
        elif _is_encryption_not_supported(error):
            result["encryptionError"] = "Not supported by this storage provider"
        else:
            print(f"Failed to get bucket encryption: {error}")
            result["encryptionError"] = str(error)
    try:
        rules = await client.get_bucket_lifecycle_configuration(bucket)
        rules_out: list[dict[str, object]] = []
        for rule in rules:
            item: dict[str, object] = {
                "id": rule.id,
                "status": rule.status or "Unknown",
                "prefix": rule.filter_prefix or rule.prefix,
            }
            if rule.expiration:
                item["expiration"] = {
                    "days": rule.expiration.days,
                    "date": isoformat_z(rule.expiration.date),
                    "expiredObjectDeleteMarker": rule.expiration.expired_object_delete_marker,
                }
            if rule.transitions:
                item["transitions"] = [
                    {
                        "days": t.days,
                        "date": isoformat_z(t.date),
                        "storageClass": t.storage_class or "Unknown",
                    }
                    for t in rule.transitions
                ]
            if rule.noncurrent_expiration_days is not None:
                item["noncurrentVersionExpiration"] = {
                    "days": rule.noncurrent_expiration_days,
                    "newerNoncurrentVersions": None,
                }
            if rule.abort_incomplete_multipart_days is not None:
                item["abortIncompleteMultipartUpload"] = {
                    "daysAfterInitiation": rule.abort_incomplete_multipart_days
                }
            rules_out.append(item)
        result["lifecycleRules"] = rules_out
    except S3Error as error:
        if not _is_lifecycle_not_configured(error):
            print(f"Failed to get bucket lifecycle: {error}")
            result["lifecycleError"] = str(error)
    return result
