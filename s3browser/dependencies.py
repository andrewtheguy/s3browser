from collections.abc import AsyncIterator

from fastapi import HTTPException

from s3browser.db import get_connection_by_id
from s3browser.s3 import S3Context, create_s3_context_from_connection


async def get_s3_context(connection_id: int, bucket: str | None = None) -> AsyncIterator[S3Context]:
    if connection_id <= 0:
        raise HTTPException(status_code=400, detail="Valid connection ID is required")
    connection = get_connection_by_id(connection_id)
    if connection is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    try:
        async with create_s3_context_from_connection(connection, bucket) as context:
            yield context
    except HTTPException:
        raise
    except Exception as error:
        print(f"Failed to create S3 client: {error}")
        raise HTTPException(status_code=500, detail="Failed to initialize S3 connection") from error
