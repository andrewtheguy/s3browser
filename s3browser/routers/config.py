from fastapi import APIRouter

from s3browser.config import get_presigned_url_ttl_options

router = APIRouter(prefix="/api/config", tags=["config"])


@router.get("")
@router.get("/")
async def get_config() -> dict[str, object]:
    return {"presignedUrlTtls": list(get_presigned_url_ttl_options())}
