// StorageAdapter: the pluggable seam for document bytes. The beta stores bytes in
// Postgres (document_blobs) so the manual review path is fully functional without
// object-storage infrastructure. R5 (security hardening) adds a Supabase Storage
// implementation of this same interface — bytes live in a private bucket as the
// SAME AES-256-GCM envelope we already store in the DB, so a leaked object URL or
// a compromised bucket yields only ciphertext; the key stays in EB_DOCUMENT_KEY.
// Reads still flow through getDocumentBytes → get() (decrypted server-side and
// served on the audited signed-URL route), so no caller changes. Not the
// ParserAdapter's "no hard-coded vendor" rule (that's about parsing); this is
// about keeping the storage backend swappable.
import type pg from 'pg';
import { decryptBytes, encryptBytes, ENC_ALGO } from './crypto';

export interface StorageAdapter {
  readonly name: string;
  // Persist bytes for a document; returns the key to store on documents.storage_key.
  put(db: pg.ClientBase, args: { documentId: string; firmId: string; bytes: Buffer }): Promise<string>;
  // Fetch bytes for a document (null if absent). The route decrypts nothing extra —
  // the adapter returns plaintext, having decrypted its own envelope.
  get(db: pg.ClientBase, documentId: string): Promise<Buffer | null>;
  // Delete a document's bytes. For the DB backend this is covered by the ON DELETE
  // CASCADE from documents, so it's effectively a no-op; for object storage it
  // deletes the bucket object (nothing cascades there). Used to compensate a
  // failed upload (server/documents/pipeline.ts) and to clean up on engagement
  // teardown (server/engagements.ts) — in BOTH cases the documents row is already
  // gone when this runs, so firmId is passed in rather than looked up (the object
  // path is deterministic: firmId/documentId). Best-effort: callers swallow errors.
  remove(db: pg.ClientBase, args: { documentId: string; firmId: string }): Promise<void>;
}

// Beta default: bytes live in the document_blobs table, so RLS covers them like
// any other row and dev needs no external storage.
export class DbBlobStorage implements StorageAdapter {
  readonly name = 'db';
  async put(
    db: pg.ClientBase,
    { documentId, firmId, bytes }: { documentId: string; firmId: string; bytes: Buffer },
  ): Promise<string> {
    // Encrypt at rest (R5): store the AES-256-GCM envelope, tagged with the algo
    // so get() knows to decrypt (legacy rows with enc_algo = null are plaintext).
    const envelope = encryptBytes(bytes);
    await db.query(
      `insert into document_blobs (document_id, firm_id, bytes, enc_algo) values ($1, $2, $3, $4)
       on conflict (document_id) do update set bytes = excluded.bytes, enc_algo = excluded.enc_algo`,
      [documentId, firmId, envelope, ENC_ALGO],
    );
    return documentId; // the key is the document id for the DB backend
  }
  async get(db: pg.ClientBase, documentId: string): Promise<Buffer | null> {
    const r = await db.query(`select bytes, enc_algo from document_blobs where document_id = $1`, [
      documentId,
    ]);
    if (!r.rows[0]) return null;
    const raw = r.rows[0].bytes as Buffer;
    return r.rows[0].enc_algo === ENC_ALGO ? decryptBytes(raw) : raw;
  }
  async remove(db: pg.ClientBase, { documentId }: { documentId: string; firmId: string }): Promise<void> {
    // The blob row cascades from documents; this explicit delete is a harmless
    // no-op when the row is already gone, keeping the interface honest.
    await db.query(`delete from document_blobs where document_id = $1`, [documentId]);
  }
}

// R5 object-storage backend: the same encrypted envelope lives in a PRIVATE
// Supabase Storage bucket instead of Postgres. Object path is firm_id/document_id
// (also stored on documents.storage_key). The service-role client bypasses storage
// RLS; the bucket is private and the browser never touches it — reads go through
// the audited server route — so no per-object storage policy is required.
export class SupabaseStorage implements StorageAdapter {
  readonly name = 'supabase';
  private readonly bucket = process.env.EB_STORAGE_BUCKET || 'documents';
  // Constructed lazily on first use: the DB backend (the default and what every
  // test imports) must never require SUPABASE_SERVICE_ROLE_KEY to be set.
  private client: import('@supabase/supabase-js').SupabaseClient | null = null;

  private async storage() {
    if (!this.client) {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) {
        throw new Error(
          'Supabase storage backend requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; unset EB_STORAGE to use the DB backend',
        );
      }
      const { createClient } = await import('@supabase/supabase-js');
      this.client = createClient(url, key, { auth: { persistSession: false } });
    }
    return this.client.storage.from(this.bucket);
  }

  private path(firmId: string, documentId: string): string {
    return `${firmId}/${documentId}`;
  }

  async put(
    _db: pg.ClientBase,
    { documentId, firmId, bytes }: { documentId: string; firmId: string; bytes: Buffer },
  ): Promise<string> {
    const key = this.path(firmId, documentId);
    const envelope = encryptBytes(bytes);
    const store = await this.storage();
    // upsert so a retry of the same document is idempotent (mirrors the DB
    // backend's ON CONFLICT DO UPDATE). Bytes are ciphertext → octet-stream.
    const { error } = await store.upload(key, envelope, {
      upsert: true,
      contentType: 'application/octet-stream',
    });
    if (error) throw new Error(`supabase storage upload failed: ${error.message}`);
    return key;
  }

  async get(db: pg.ClientBase, documentId: string): Promise<Buffer | null> {
    // get() only receives the document id; recover the object path (and firm) from
    // the committed documents row. Fall back to the deterministic path if an older
    // row never stored a storage_key.
    const r = await db.query(`select firm_id, storage_key from documents where id = $1`, [documentId]);
    const row = r.rows[0];
    if (!row) return null;
    const key = (row.storage_key as string) || this.path(row.firm_id as string, documentId);
    const store = await this.storage();
    const { data, error } = await store.download(key);
    if (error || !data) return null;
    const raw = Buffer.from(await data.arrayBuffer());
    return decryptBytes(raw);
  }

  async remove(_db: pg.ClientBase, { documentId, firmId }: { documentId: string; firmId: string }): Promise<void> {
    // The documents row is already gone by the time this runs, so derive the
    // object path deterministically (put always uses firmId/documentId).
    const store = await this.storage();
    await store.remove([this.path(firmId, documentId)]);
  }
}

export function resolveStorage(): StorageAdapter {
  // Default: the DB backend (no external storage needed for dev/CI). EB_STORAGE
  // selects an alternative; unknown values throw so a misconfiguration is loud.
  const which = (process.env.EB_STORAGE ?? 'db').toLowerCase();
  if (which === 'db') return new DbBlobStorage();
  if (which === 'supabase') return new SupabaseStorage();
  throw new Error(`storage backend '${which}' is not implemented in this build; unset EB_STORAGE`);
}
