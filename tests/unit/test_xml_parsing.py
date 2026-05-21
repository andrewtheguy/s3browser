from __future__ import annotations

from datetime import UTC, datetime

from s3browser.async_s3.xml_parsing import (
    KeyToDelete,
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
)


def test_parse_list_objects_v2_with_namespace():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <Prefix>photos/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>photos/a.jpg</Key>
    <LastModified>2024-01-02T03:04:05.000Z</LastModified>
    <Size>1024</Size>
    <ETag>"abc"</ETag>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>photos/b.jpg</Key>
    <LastModified>2024-01-02T03:04:06Z</LastModified>
    <Size>2048</Size>
    <ETag>"def"</ETag>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <CommonPrefixes>
    <Prefix>photos/sub/</Prefix>
  </CommonPrefixes>
</ListBucketResult>"""
    result = parse_list_objects_v2(xml)
    assert result.key_count == 2
    assert result.is_truncated is False
    assert result.next_continuation_token is None
    assert [c.key for c in result.contents] == ["photos/a.jpg", "photos/b.jpg"]
    assert result.contents[0].size == 1024
    assert result.contents[0].etag == '"abc"'
    assert result.contents[0].last_modified == datetime(2024, 1, 2, 3, 4, 5, tzinfo=UTC)
    assert result.common_prefixes == ["photos/sub/"]


def test_parse_list_objects_v2_continuation_token():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>opaque-token</NextContinuationToken>
  <KeyCount>1</KeyCount>
  <Contents>
    <Key>a</Key>
    <Size>1</Size>
  </Contents>
</ListBucketResult>"""
    result = parse_list_objects_v2(xml)
    assert result.is_truncated is True
    assert result.next_continuation_token == "opaque-token"


def test_parse_list_object_versions_mixes_versions_and_delete_markers():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Version>
    <Key>doc.txt</Key>
    <VersionId>v1</VersionId>
    <IsLatest>false</IsLatest>
    <LastModified>2024-01-01T00:00:00Z</LastModified>
    <Size>100</Size>
    <ETag>"v1etag"</ETag>
    <StorageClass>STANDARD</StorageClass>
  </Version>
  <DeleteMarker>
    <Key>doc.txt</Key>
    <VersionId>dm1</VersionId>
    <IsLatest>true</IsLatest>
    <LastModified>2024-01-02T00:00:00Z</LastModified>
  </DeleteMarker>
</ListVersionsResult>"""
    result = parse_list_object_versions(xml)
    assert len(result.versions) == 2
    version = next(v for v in result.versions if v.version_id == "v1")
    marker = next(v for v in result.versions if v.version_id == "dm1")
    assert version.is_delete_marker is False
    assert marker.is_delete_marker is True
    assert marker.is_latest is True


def test_parse_list_buckets():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>x</ID><DisplayName>me</DisplayName></Owner>
  <Buckets>
    <Bucket><Name>one</Name><CreationDate>2023-06-01T12:00:00Z</CreationDate></Bucket>
    <Bucket><Name>two</Name><CreationDate>2024-01-01T00:00:00.000Z</CreationDate></Bucket>
  </Buckets>
</ListAllMyBucketsResult>"""
    buckets = parse_list_buckets(xml)
    assert [b.name for b in buckets] == ["one", "two"]
    assert buckets[0].creation_date == datetime(2023, 6, 1, 12, 0, 0, tzinfo=UTC)


def test_parse_create_multipart():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>b</Bucket>
  <Key>k</Key>
  <UploadId>UPLOAD-ID-123</UploadId>
</InitiateMultipartUploadResult>"""
    assert parse_create_multipart(xml) == "UPLOAD-ID-123"


def test_parse_complete_multipart():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>https://b.s3.amazonaws.com/k</Location>
  <Bucket>b</Bucket>
  <Key>k</Key>
  <ETag>"final-etag"</ETag>
</CompleteMultipartUploadResult>"""
    result = parse_complete_multipart(xml)
    assert result.bucket == "b"
    assert result.key == "k"
    assert result.etag == '"final-etag"'


def test_parse_copy_object():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <ETag>"copy-etag"</ETag>
  <LastModified>2024-03-04T05:06:07Z</LastModified>
</CopyObjectResult>"""
    result = parse_copy_object(xml)
    assert result.etag == '"copy-etag"'
    assert result.last_modified == datetime(2024, 3, 4, 5, 6, 7, tzinfo=UTC)


def test_parse_delete_objects():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Deleted><Key>a</Key></Deleted>
  <Deleted><Key>b</Key><VersionId>v</VersionId><DeleteMarker>true</DeleteMarker><DeleteMarkerVersionId>dmv</DeleteMarkerVersionId></Deleted>
  <Error><Key>c</Key><Code>AccessDenied</Code><Message>nope</Message></Error>
</DeleteResult>"""
    result = parse_delete_objects(xml)
    assert [d.key for d in result.deleted] == ["a", "b"]
    assert result.deleted[1].delete_marker is True
    assert result.deleted[1].delete_marker_version_id == "dmv"
    assert len(result.errors) == 1
    assert result.errors[0].code == "AccessDenied"


def test_parse_bucket_location_with_constraint():
    xml = b'<?xml version="1.0"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">eu-west-1</LocationConstraint>'
    assert parse_bucket_location(xml) == "eu-west-1"


def test_parse_bucket_location_empty():
    xml = b'<?xml version="1.0"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>'
    assert parse_bucket_location(xml) is None


def test_parse_bucket_versioning_enabled():
    xml = b"""<?xml version="1.0"?>
<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Status>Enabled</Status>
</VersioningConfiguration>"""
    result = parse_bucket_versioning(xml)
    assert result.status == "Enabled"
    assert result.mfa_delete is None


def test_parse_bucket_encryption():
    xml = b"""<?xml version="1.0"?>
<ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Rule>
    <ApplyServerSideEncryptionByDefault>
      <SSEAlgorithm>AES256</SSEAlgorithm>
    </ApplyServerSideEncryptionByDefault>
    <BucketKeyEnabled>true</BucketKeyEnabled>
  </Rule>
</ServerSideEncryptionConfiguration>"""
    result = parse_bucket_encryption(xml)
    assert len(result.rules) == 1
    assert result.rules[0].sse_algorithm == "AES256"
    assert result.rules[0].bucket_key_enabled is True


def test_parse_bucket_lifecycle():
    xml = b"""<?xml version="1.0"?>
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Rule>
    <ID>expire-old</ID>
    <Status>Enabled</Status>
    <Filter><Prefix>logs/</Prefix></Filter>
    <Expiration><Days>30</Days></Expiration>
    <Transition><Days>10</Days><StorageClass>GLACIER</StorageClass></Transition>
    <AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload>
  </Rule>
</LifecycleConfiguration>"""
    rules = parse_bucket_lifecycle(xml)
    assert len(rules) == 1
    rule = rules[0]
    assert rule.id == "expire-old"
    assert rule.status == "Enabled"
    assert rule.filter_prefix == "logs/"
    assert rule.expiration is not None and rule.expiration.days == 30
    assert rule.transitions[0].storage_class == "GLACIER"
    assert rule.abort_incomplete_multipart_days == 7


def test_build_delete_objects_body_escapes_keys():
    body = build_delete_objects_body(
        [KeyToDelete(key="a&b"), KeyToDelete(key="c", version_id="v")],
        quiet=True,
    )
    decoded = body.decode("utf-8")
    assert "<Delete>" in decoded
    assert "<Quiet>true</Quiet>" in decoded
    assert "<Key>a&amp;b</Key>" in decoded
    assert "<VersionId>v</VersionId>" in decoded


def test_build_complete_multipart_body_orders_parts_as_given():
    body = build_complete_multipart_body(
        [MultipartPart(part_number=1, etag='"e1"'), MultipartPart(part_number=2, etag='"e2"')]
    )
    decoded = body.decode("utf-8")
    assert decoded.index("<PartNumber>1</PartNumber>") < decoded.index("<PartNumber>2</PartNumber>")
    assert '<ETag>"e1"</ETag>' in decoded
    assert '<ETag>"e2"</ETag>' in decoded
