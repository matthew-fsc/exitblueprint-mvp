// StorageAdapter: the pluggable seam for document bytes. The beta stores bytes in
// Postgres (document_blobs) so the manual review path is fully functional without
// object-storage infrastructure. R5 (security hardening) swaps in a Supabase
// Storage implementation of this same interface — encryption at rest + short
// expiry signed URLs — without changing any caller. Not the ParserAdapter's
// "no hard-coded vendor" rule (that's about parsing); this is about keeping the
// storage backend swappable.
import type pg from 'pg';
import { decryptBytes, encryptBytes, ENC_ALGO } from './crypto';

export interface StorageAdapter {
  readonly name: string;
  // Persist bytes for a document; returns the key to store on documents.storage_key.
  put(db: pg.ClientBase, args: { documentId: string; firmId: string; bytes: Buffer }): Promise<string>;
  // Fetch bytes for a document (null if absent). The beta serves these through
  // an authorized function; R5's adapter returns a signed URL instead.
  get(db: pg.ClientBase, documentId: string): Promise<Buffer | null>;
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
}

export function resolveStorage(): StorageAdapter {
  // Only the DB backend exists in the beta; the env switch is the seam R5 uses
  // to introduce 'supabase' without touching callers.
  const which = (process.env.EB_STORAGE ?? 'db').toLowerCase();
  if (which === 'db') return new DbBlobStorage();
  throw new Error(`storage backend '${which}' is not implemented in this build; unset EB_STORAGE`);
}
