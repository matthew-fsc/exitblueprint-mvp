// Beta Requirement 3: the document intake pipeline. Stages: upload → virus scan
// → classification → extraction (ParserAdapter) → human review → verified fact.
// The automated stages may be partial (the beta's manual adapter extracts
// nothing); the MANUAL review path is complete. Nothing here writes to a score.
import type pg from 'pg';
import { resolveParser } from './parser';
import { resolveStorage } from './storage';

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB cap on a base64-uploaded document

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

  const bytes = Buffer.from(input.content_base64, 'base64');
  if (bytes.length === 0) throw new Error('uploaded file is empty');
  if (bytes.length > MAX_BYTES) throw new Error(`file exceeds ${MAX_BYTES} byte limit`);

  const engagement = await db.query(`select id from engagements where id = $1 and firm_id = $2`, [
    input.engagement_id,
    firmId,
  ]);
  if (engagement.rowCount !== 1) throw new Error('engagement not found in this firm');

  const storage = resolveStorage();
  const parser = resolveParser();

  await db.query('begin');
  try {
    const doc = await db.query(
      `insert into documents
         (firm_id, engagement_id, category, original_filename, mime_type, byte_size, uploaded_by, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'uploaded') returning id`,
      [
        firmId,
        input.engagement_id,
        input.category ?? null,
        input.filename,
        input.mime_type || 'application/octet-stream',
        bytes.length,
        uploaderId,
      ],
    );
    const documentId = doc.rows[0].id as string;

    const storageKey = await storage.put(db, { documentId, firmId, bytes });

    // Virus scan — a stub in the beta (uploads are from trusted advisors); a real
    // scanner is wired in R5/ops. Recorded honestly as 'skipped', not 'clean'.
    await db.query(`update documents set scan_status = 'skipped', status = 'scanned' where id = $1`, [
      documentId,
    ]);

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
