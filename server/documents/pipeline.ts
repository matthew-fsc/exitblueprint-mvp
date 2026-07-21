// Beta Requirement 3: the document intake pipeline. Stages: upload → virus scan
// → classification → extraction (ParserAdapter) → human review → verified fact.
// The automated stages may be partial (the beta's manual adapter extracts
// nothing); the MANUAL review path is complete. Nothing here writes to a score.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { resolveParser } from './parser';
import { resolveScanner } from './scanner';
import { resolveStorage } from './storage';

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB cap on a base64-uploaded document

// ---------------------------------------------------------------------------
// Ingestion-integrity helpers (pure; unit-tested in tests/document-integrity.test.ts)
// ---------------------------------------------------------------------------

// A scan verdict is only allowed to proceed (store/extract) or be served when it
// is 'clean'. 'skipped' (the NoopScanner beta default) is allowed OUTSIDE
// production so local/CI keeps working, but in production a skipped scan is
// treated as un-scanned → non-storable and non-servable. Everything else
// (infected, pending, unknown) is blocked. Prod is detected exactly as the rest
// of the server does: NODE_ENV === 'production' (see server/http.ts).
export function scanVerdictAllowsServe(scanStatus: string): boolean {
  if (scanStatus === 'clean') return true;
  if (scanStatus === 'skipped') return process.env.NODE_ENV !== 'production';
  return false;
}

// Strip anything that could turn a stored filename into a header-injection or
// path-traversal vector before it is persisted or echoed into a
// Content-Disposition header: drop any directory portion, then remove control
// chars (incl. CR/LF), quotes and backslashes. Falls back to a safe default.
export function sanitizeFilename(name: string): string {
  const base = (name ?? '').split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f"']/g, '').trim();
  return cleaned || 'document';
}

// Known file signatures (magic bytes). Types WITHOUT a signature — csv, txt and
// anything unlisted — are intentionally absent: they are ALWAYS allowed through.
const FILE_SIGNATURES: { ext: Set<string>; matches: (b: Buffer) => boolean }[] = [
  // %PDF
  { ext: new Set(['pdf']), matches: (b) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  // \x89 P N G \r \n \x1a \n
  {
    ext: new Set(['png']),
    matches: (b) =>
      b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  // JPEG SOI + marker
  { ext: new Set(['jpg', 'jpeg']), matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // ZIP-based OOXML (xlsx/docx): PK\x03\x04 (also \x05\x06 empty, \x07\x08 spanned)
  {
    ext: new Set(['xlsx', 'docx', 'zip']),
    matches: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07),
  },
  // Legacy OLE compound file (xls/doc): D0 CF 11 E0 A1 B1 1A E1
  {
    ext: new Set(['xls', 'doc']),
    matches: (b) =>
      b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1,
  },
];

// Detect a CLEAR signature mismatch: the claimed extension has a known signature,
// the bytes do NOT match it, AND the bytes DO match some OTHER known signature
// (e.g. a PNG renamed to .pdf). We deliberately do NOT reject a signatureless
// payload carrying a signed extension (a placeholder ".pdf" whose bytes aren't
// %PDF) — text/CSV/TXT have no signature and several trusted upload flows (the
// data-room attach path, evidence fixtures) legitimately store short non-binary
// bytes under a .pdf name. Catching only positive mismatches blocks the real
// type-confusion attack without breaking those flows; safe-serve
// (Content-Disposition: attachment + sandboxed preview) covers the rest.
export function signatureMismatch(filename: string, bytes: Buffer): boolean {
  const ext = extensionOf(filename);
  const claimed = FILE_SIGNATURES.find((s) => s.ext.has(ext));
  if (!claimed) return false; // extension has no known signature → allow
  if (claimed.matches(bytes)) return false; // bytes match the claimed type → allow
  const actual = FILE_SIGNATURES.find((s) => s.matches(bytes));
  return actual !== undefined; // bytes are a DIFFERENT known type → mismatch
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

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
  // Store a sanitized filename — never the raw client string, which could carry
  // path separators or header-injection chars (used verbatim in the download
  // Content-Disposition header). The extension check above still runs on the
  // original so a sanitized-away extension can't smuggle a disallowed type.
  const safeFilename = sanitizeFilename(input.filename);

  const bytes = Buffer.from(input.content_base64, 'base64');
  if (bytes.length === 0) throw new Error('uploaded file is empty');
  if (bytes.length > MAX_BYTES) throw new Error(`file exceeds ${MAX_BYTES} byte limit`);

  // Magic-byte sniff: reject a clear signature mismatch (a binary of one known
  // type wearing another type's extension). Signatureless payloads (CSV/TXT and
  // any type without a known signature) always pass — see signatureMismatch.
  if (signatureMismatch(input.filename, bytes)) {
    throw new Error(
      `file contents do not match the '.${extensionOf(input.filename)}' extension (possible renamed file)`,
    );
  }

  const engagement = await db.query(`select id from engagements where id = $1 and firm_id = $2`, [
    input.engagement_id,
    firmId,
  ]);
  if (engagement.rowCount !== 1) throw new Error('engagement not found in this firm');

  // Content-hash de-duplication (docs/06). Within one engagement the SAME file
  // is often uploaded twice — attached from the data room and again as a generic
  // upload, or simply re-sent. Rather than create a second document (and a second
  // review task), link the caller back to the existing one. Scoped to
  // firm_id + engagement_id and skips 'rejected' rows so a prior infected/blocked
  // upload never shadows a genuine re-upload. Computed on the plaintext bytes.
  const contentSha256 = sha256Hex(bytes);
  const dup = await db.query(
    `select id, status from documents
      where firm_id = $1 and engagement_id = $2 and content_sha256 = $3 and status <> 'rejected'
      order by created_at asc limit 1`,
    [firmId, input.engagement_id, contentSha256],
  );
  if (dup.rowCount === 1) {
    return {
      document_id: dup.rows[0].id as string,
      status: dup.rows[0].status as string,
      fields_extracted: 0,
    };
  }

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
          scan_status, status, content_sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'scanned', $9) returning id`,
      [
        firmId,
        input.engagement_id,
        input.category ?? null,
        safeFilename,
        input.mime_type || 'application/octet-stream',
        bytes.length,
        uploaderId,
        verdict.status,
        contentSha256,
      ],
    );
    documentId = doc.rows[0].id as string;

    // Scan gate: bytes are stored/extracted only when the scan verdict permits it
    // — 'clean' always, 'skipped' only outside production (the NoopScanner beta
    // default). 'infected', a skipped scan IN production, or any other verdict is
    // rejected: nothing is stored, nothing is extracted, and the rejected row is
    // kept as an auditable record of the blocked upload.
    if (!scanVerdictAllowsServe(verdict.status)) {
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
      // Parser output is written as verification_status='extracted' — NEVER
      // 'verified'. Only a human review (submitDocumentReview) promotes a field to
      // 'verified', and per CLAUDE.md rule 2 ONLY verification_status='verified'
      // fields may ever sync to answers/scoring. No parser/LLM output feeds a score.
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
    await db.query(`select mime_type, original_filename, scan_status from documents where id = $1`, [
      documentId,
    ])
  ).rows[0];
  if (!doc) return null;
  // Serve gate (mirrors the store gate): never hand back bytes whose scan verdict
  // doesn't permit it — a skipped scan is servable only outside production, an
  // infected/other verdict never. Returning null surfaces as a 404 on the
  // download route and get-document, so un-scanned bytes are never disclosed.
  if (!scanVerdictAllowsServe(doc.scan_status as string)) return null;
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
  const doc = await db.query(`select id, status from documents where id = $1 and firm_id = $2`, [
    input.document_id,
    firmId,
  ]);
  if (doc.rowCount !== 1) throw new Error('document not found in this firm');
  const currentStatus = doc.rows[0].status as string;

  const verify = input.verify !== false; // default: submitting a review verifies
  // Status guard: only a document sitting in the review queue ('in_review') may be
  // promoted to 'verified'. Blocks re-verifying an already-verified doc, verifying
  // a rejected/infected upload, or verifying one still mid-pipeline. Saving a
  // review without verifying (verify=false) is allowed from any state.
  if (verify && currentStatus !== 'in_review') {
    throw new Error(
      `document cannot be verified from status '${currentStatus}'; only 'in_review' documents may be verified`,
    );
  }

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

    if (verify) {
      // Require every auto-extracted field to have been confirmed first. Any
      // document_fields row still 'extracted' (unreviewed parser output) blocks
      // verification — a verified document must contain only human-confirmed
      // ('verified') facts, never raw extraction. This is checked
      // AFTER the loop above, so fields the reviewer just confirmed no longer
      // count. A zero-field document (the manual-adapter beta path) has no
      // 'extracted' rows and so verifies normally.
      const unconfirmed = await db.query(
        `select count(*)::int as n from document_fields
          where document_id = $1 and verification_status = 'extracted'`,
        [input.document_id],
      );
      const remaining = unconfirmed.rows[0].n as number;
      if (remaining > 0) {
        throw new Error(
          `cannot verify: ${remaining} auto-extracted field(s) are still unconfirmed; confirm or correct them first`,
        );
      }

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
