// Beta Requirement 3: the document intake pipeline. Stages: upload → virus scan
// → classification → extraction (ParserAdapter) → human review → verified fact.
// The automated stages may be partial (the beta's manual adapter extracts
// nothing); the MANUAL review path is complete. Nothing here writes to a score.
import type pg from 'pg';
import { resolveParser } from './parser';
import { resolveScanner } from './scanner';
import { resolveStorage } from './storage';

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB cap on a base64-uploaded document

// Server-side allow-list (defense in depth; the client enforces the same set).
// Gated on extension, not the browser-supplied mime_type, which is unreliable
// (often empty or application/octet-stream). Kept permissive — the document types
// an advisor actually assembles for a diligence binder.
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'csv', 'txt', 'xls', 'xlsx', 'doc', 'docx', 'png', 'jpg', 'jpeg',
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function assertAllowedType(filename: string): void {
  const ext = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `file type '${ext || 'unknown'}' is not allowed; accepted types: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    );
  }
}

export interface UploadDocumentInput {
  engagement_id: string;
  category?: string | null;
  filename: string;
  mime_type: string;
  content_base64: string;
}

// Upload + run the automated stages, landing the document in the review queue.
// firmId is the caller's trusted firm (from authorize); uploaderId is their
// profile. Runs in one transaction so a failure leaves no half-ingested doc.
export async function uploadDocument(
  db: pg.ClientBase,
  firmId: string,
  uploaderId: string | null,
  input: UploadDocumentInput,
): Promise<{ document_id: string; status: string; fields_extracted: number }> {
  if (typeof input.engagement_id !== 'string') throw new Error('engagement_id required');
  if (typeof input.filename !== 'string' || !input.filename) throw new Error('filename required');
  if (typeof input.content_base64 !== 'string' || !input.content_base64) throw new Error('content_base64 required');
  assertAllowedType(input.filename);

  const bytes = Buffer.from(input.content_base64, 'base64');
  if (bytes.length === 0) throw new Error('uploaded file is empty');
  if (bytes.length > MAX_BYTES) throw new Error(`file exceeds ${MAX_BYTES} byte limit`);

  const engagement = await db.query(`select id from engagements where id = $1 and firm_id = $2`, [
    input.engagement_id,
    firmId,
  ]);
  if (engagement.rowCount !== 1) throw new Error('engagement not found in this firm');

  const storage = resolveStorage();
  const scanner = resolveScanner();
  const parser = resolveParser();

  // Scan the plaintext BEFORE anything is stored: infected bytes are never
  // persisted, so there is no malware object to clean up. Fail-closed — a
  // configured-but-unreachable scanner throws here and the whole upload fails.
  const verdict = await scanner.scan({
    bytes,
    filename: input.filename,
    mimeType: input.mime_type || 'application/octet-stream',
  });

  let documentId: string | null = null;
  await db.query('begin');
  try {
    const doc = await db.query(
      `insert into documents
         (firm_id, engagement_id, category, original_filename, mime_type, byte_size, uploaded_by,
          scan_status, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'scanned') returning id`,
      [
        firmId,
        input.engagement_id,
        input.category ?? null,
        input.filename,
        input.mime_type || 'application/octet-stream',
        bytes.length,
        uploaderId,
        verdict.status,
      ],
    );
    documentId = doc.rows[0].id as string;

    // Infected → reject immediately. Nothing is stored, nothing is extracted; the
    // rejected row is kept as an auditable record of the blocked upload.
    if (verdict.status === 'infected') {
      await db.query(`update documents set status = 'rejected' where id = $1`, [documentId]);
      await db.query('commit');
      return { document_id: documentId, status: 'rejected', fields_extracted: 0 };
    }

    const storageKey = await storage.put(db, { documentId, firmId, bytes });

    // Classify + extract via the active ParserAdapter (manual = no fields).
    const parsed = await parser.parse({
      bytes,
      mimeType: input.mime_type,
      filename: input.filename,
      category: input.category ?? null,
    });

    let extracted = 0;
    for (const f of parsed.fields) {
      const questionId = f.questionCode
        ? (await db.query(`select q.id from questions q where q.code = $1 limit 1`, [f.questionCode]))
            .rows[0]?.id ?? null
        : null;
      await db.query(
        `insert into document_fields
           (firm_id, document_id, question_id, field_key, value, verification_status, confidence)
         values ($1, $2, $3, $4, $5, 'extracted', $6)`,
        [firmId, documentId, questionId, f.fieldKey, f.value, f.confidence ?? null],
      );
      extracted++;
    }

    await db.query(
      `update documents set storage_key = $2, classification = $3, parser_name = $4,
         status = 'in_review' where id = $1`,
      [documentId, storageKey, parsed.classification, parsed.parserName],
    );

    await db.query('commit');
    return { document_id: documentId, status: 'in_review', fields_extracted: extracted };
  } catch (e) {
    await db.query('rollback').catch(() => {});
    // Compensate for a storage write that a later failure can't roll back (a
    // Supabase bucket object is a network side-effect outside the DB txn). No-op
    // for the DB backend; best-effort so it never masks the original error.
    if (documentId) await storage.remove(db, { documentId, firmId }).catch(() => {});
    throw e;
  }
}

export interface ReviewQueueItem {
  document_id: string;
  engagement_id: string;
  company_name: string;
  original_filename: string;
  category: string | null;
  status: string;
  field_count: number;
  created_at: string;
}

// Documents still awaiting human review, firm-scoped (RLS also enforces this).
export async function listReviewQueue(db: pg.ClientBase, firmId: string): Promise<ReviewQueueItem[]> {
  const r = await db.query(
    `select d.id as document_id, d.engagement_id, c.name as company_name,
            d.original_filename, d.category, d.status, d.created_at,
            (select count(*)::int from document_fields f where f.document_id = d.id) as field_count
       from documents d
       join engagements e on e.id = d.engagement_id
       join companies c on c.id = e.company_id
      where d.firm_id = $1 and d.status = 'in_review'
      order by d.created_at asc`,
    [firmId],
  );
  return r.rows as ReviewQueueItem[];
}

// Full document + its fields for the review detail view.
export async function getDocumentDetail(db: pg.ClientBase, documentId: string) {
  const doc = (
    await db.query(
      `select d.*, c.name as company_name
         from documents d
         join engagements e on e.id = d.engagement_id
         join companies c on c.id = e.company_id
        where d.id = $1`,
      [documentId],
    )
  ).rows[0];
  if (!doc) throw new Error('document not found');
  const fields = (
    await db.query(
      `select id, field_key, value, verification_status, confidence, question_id
         from document_fields where document_id = $1 order by created_at asc`,
      [documentId],
    )
  ).rows;
  return { document: doc, fields };
}

// Return the raw bytes for the source-document viewer (served like the PDF path).
export async function getDocumentBytes(
  db: pg.ClientBase,
  documentId: string,
): Promise<{ bytes: Buffer; mime: string; filename: string } | null> {
  const doc = (
    await db.query(`select mime_type, original_filename from documents where id = $1`, [documentId])
  ).rows[0];
  if (!doc) return null;
  const bytes = await resolveStorage().get(db, documentId);
  if (!bytes) return null;
  return { bytes, mime: doc.mime_type as string, filename: doc.original_filename as string };
}

// The data-room item states a verified document must NOT override — an advisor's
// explicit judgement that an item is a gap or out of scope always wins over the
// automatic "verified document ⇒ Ready" rule. Kept as the single source of truth
// for that rule so it stays in lock-step with the SQL predicate in
// submitDocumentReview and is unit-testable without a database.
export const AUTO_READY_PROTECTED_STATES = ['gap', 'not_applicable'] as const;

/** Whether a linked item in this state should auto-advance to 'ready' when its
 * document is verified. False only for the advisor-set protected states. */
export function dataRoomAutoReadyEligible(state: string): boolean {
  return !(AUTO_READY_PROTECTED_STATES as readonly string[]).includes(state);
}

export interface ReviewFieldInput {
  id?: string; // existing document_field id; omit to add a new manual field
  field_key: string;
  value: string | null;
}

// The manual review action: confirm/correct extracted fields, add manual ones,
// and mark the document a verified fact. Corrections are logged for parser
// accuracy. Runs in one transaction.
export async function submitDocumentReview(
  db: pg.ClientBase,
  firmId: string,
  reviewerId: string | null,
  input: { document_id: string; fields: ReviewFieldInput[]; verify?: boolean },
): Promise<{ document_id: string; status: string; verified_fields: number }> {
  if (typeof input.document_id !== 'string') throw new Error('document_id required');
  const doc = await db.query(`select id from documents where id = $1 and firm_id = $2`, [
    input.document_id,
    firmId,
  ]);
  if (doc.rowCount !== 1) throw new Error('document not found in this firm');

  await db.query('begin');
  try {
    let verifiedCount = 0;
    for (const f of input.fields ?? []) {
      if (f.id) {
        const existing = (
          await db.query(`select value from document_fields where id = $1 and document_id = $2`, [
            f.id,
            input.document_id,
          ])
        ).rows[0];
        if (!existing) continue;
        if ((existing.value ?? null) !== (f.value ?? null)) {
          // A correction of an extracted value — log it for accuracy tracking.
          await db.query(
            `insert into field_corrections (firm_id, document_field_id, original_value, corrected_value, corrected_by)
             values ($1, $2, $3, $4, $5)`,
            [firmId, f.id, existing.value ?? null, f.value ?? null, reviewerId],
          );
        }
        await db.query(
          `update document_fields
             set value = $2, verification_status = 'verified', verified_by = $3, verified_at = now()
           where id = $1`,
          [f.id, f.value ?? null, reviewerId],
        );
      } else {
        // A manually-entered fact confirmed against the source.
        await db.query(
          `insert into document_fields
             (firm_id, document_id, field_key, value, verification_status, verified_by, verified_at)
           values ($1, $2, $3, $4, 'verified', $5, now())`,
          [firmId, input.document_id, f.field_key, f.value ?? null, reviewerId],
        );
      }
      verifiedCount++;
    }

    const verify = input.verify !== false; // default: submitting a review verifies
    if (verify) {
      await db.query(
        `update documents set status = 'verified', reviewed_by = $2, reviewed_at = now() where id = $1`,
        [input.document_id, reviewerId],
      );

      // Auto-derive data-room readiness from document verification. When a
      // document that is LINKED to an engagement_data_room_item becomes verified,
      // the item it answers is now proven, so advance it to 'ready' — closing the
      // drift where an item stayed not_started/in_progress while its source file
      // was already verified. Additive + defensive: a no-op when no item links to
      // this document. Never overrides an advisor's explicit 'gap' or
      // 'not_applicable' judgement (see AUTO_READY_PROTECTED_STATES).
      await db.query(
        `update engagement_data_room_items
            set readiness_state = 'ready', updated_at = now()
          where document_id = $1 and firm_id = $2
            and readiness_state not in ('gap', 'not_applicable')`,
        [input.document_id, firmId],
      );
    }

    await db.query('commit');
    return {
      document_id: input.document_id,
      status: verify ? 'verified' : 'in_review',
      verified_fields: verifiedCount,
    };
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }
}
