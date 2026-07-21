-- Document ingestion hardening (docs/27 patterns): content-hash de-duplication
-- and a confidence sanity bound. ADDITIVE ONLY — one new nullable column + index
-- and one CHECK constraint. No RLS changes, no data backfill, no engine logic
-- change. See server/documents/pipeline.ts for the code that uses these.

-- Hex sha256 of the uploaded plaintext bytes. Nullable: legacy rows predate it
-- and nothing backfills. Used to collapse a re-upload of the EXACT same file
-- within one engagement onto the existing document instead of creating a
-- duplicate (uploadDocument). Indexed by (engagement_id, content_sha256) so the
-- dedup lookup is a single firm/engagement-scoped probe.
alter table documents add column content_sha256 text;
create index on documents (engagement_id, content_sha256);

-- Parser confidence is a probability in [0,1]; null means manual entry (no
-- probability). Guard against an adapter writing an out-of-range value that would
-- then drive a bogus banding/"needs review" decision. All existing fixtures use
-- 0.6–1.0 or null, so this validates cleanly against current data.
alter table document_fields
  add constraint document_fields_confidence_range
  check (confidence is null or (confidence >= 0 and confidence <= 1));
