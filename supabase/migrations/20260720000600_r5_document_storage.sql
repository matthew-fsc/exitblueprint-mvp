-- R5 security hardening: the PRIVATE Supabase Storage bucket that holds document
-- bytes when the object-storage backend is active (EB_STORAGE=supabase,
-- server/documents/storage.ts → SupabaseStorage). Bytes are stored as the same
-- AES-256-GCM envelope we already keep in the DB, so even the bucket holds only
-- ciphertext; the bucket must be PRIVATE (public = false) because the browser
-- never touches it — reads go through the audited server route on a signed URL.
--
-- This runs against real Supabase only. The local/CI shim (db/supabase-shim.sql)
-- provides the `auth` schema but NOT `storage`, so the whole body is guarded on
-- the storage schema existing: it no-ops on plain Postgres, keeping `db:migrate`
-- green on a fresh dev/CI database. The bucket name matches the EB_STORAGE_BUCKET
-- default ('documents'); if you point EB_STORAGE_BUCKET elsewhere, create that
-- bucket (private) by hand.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('documents', 'documents', false, 15728640)  -- 15 MB, matches the upload cap
    on conflict (id) do nothing;
  end if;
end
$$;
