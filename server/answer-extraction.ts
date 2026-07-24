// Answer extraction (docs/sellside-ai WS-EXTRACT). Assessment intake is manual;
// this reads a data-room document and PROPOSES candidate answers a human confirms.
//
// THE INVARIANT (CLAUDE.md rules 1 & 2). The AI never writes to a scoring table.
// Extraction stages rows in `answer_candidates` — a review queue, NOT the DRS
// inputs. Nothing here touches `answers`. An answer only reaches the assessment
// when a HUMAN confirms a candidate (confirmAnswerCandidate), which promotes it
// through the SAME deterministic answer-writing path the manual intake and the
// ledger sync use (`insert into answers … on conflict …` + answer_provenance).
// So the score stays rule-based and human-gated: the model proposes, a person
// disposes, and the scorer recomputes deterministically from the confirmed answer.
//
// The extraction call runs on the 'economy' model tier (the cheapest/free model):
// this is mechanical, values-only work, validated against a strict schema
// (answerCandidatesOutputSchema) that rejects any prose or malformed output before
// a candidate is staged. Each candidate is stamped with the model + prompt_version
// that proposed it (rule 6).
import type pg from 'pg';
import { LlmClient } from './llm/client';
import { extractAnswerCandidatesV1 } from './llm/prompts';
import { answerCandidatesOutputSchema, type AnswerCandidate } from '../shared/intelligence/schemas';
import { getDocumentBytes } from './documents/pipeline';
import { logProvenanceEvent } from './audit';

// The prompt_version stamped on every candidate/answer this module proposes — the
// prompt key is the single source of truth (rule 6), never a local literal.
export const PROMPT_VERSION = extractAnswerCandidatesV1.key; // 'extract.answer_candidates.v1'

// One staged candidate row, as returned to the caller / the review UI.
export interface AnswerCandidateRow {
  id: string;
  engagement_id: string;
  assessment_id: string;
  question_code: string;
  candidate_value: unknown;
  confidence: number | null;
  source_document_id: string | null;
  source_span: string | null;
  status: 'pending' | 'confirmed' | 'rejected';
  model: string;
  prompt_version: string;
  created_at: string;
}

export interface ExtractOptions {
  firmId: string;
  engagementId: string;
  documentId: string;
  llm?: LlmClient;
  // The document's text. Injectable so the extraction is hermetically testable;
  // the default reads the stored document bytes as UTF-8 (data-room sources are
  // CSV/TSV/TXT/JSON exports — see server/pl-extract.ts).
  readText?: (db: pg.ClientBase, documentId: string) => Promise<string>;
}

export interface ExtractResult {
  assessment_id: string;
  proposed: number;
  candidates: AnswerCandidateRow[];
}

// Default document-text reader: the stored bytes, decoded UTF-8. Reuses the
// scan-gated getDocumentBytes so infected/unscanned bytes are never read.
async function readDocumentText(db: pg.ClientBase, documentId: string): Promise<string> {
  const d = await getDocumentBytes(db, documentId);
  if (!d) throw new Error('document not found or not readable');
  return d.bytes.toString('utf8');
}

// Validate the raw LLM output into candidates for KNOWN questions only. Throws if
// the output is not JSON or does not match the strict schema (values-only) — a
// malformed / prose response is rejected, never staged. Candidates whose
// question_code is not a real scored question in the rubric are dropped (defense
// in depth: the model can only propose answers to questions that exist).
export function parseAnswerCandidates(rawText: string, allowedCodes: Set<string>): AnswerCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('extraction output is not valid JSON');
  }
  const out = answerCandidatesOutputSchema.parse(parsed); // throws on non-conforming output
  return out.candidates.filter((c) => allowedCodes.has(c.question_code));
}

// Extract candidate answers from one data-room document into the staging queue.
// Resolves the engagement's OPEN (in_progress) assessment — candidates fill the
// assessment currently being built — reads the document text, asks the economy
// model for values-only proposals, validates them, and inserts pending candidates.
// Writes ONLY to answer_candidates; never to `answers` (rule 2).
export async function extractAnswerCandidates(
  db: pg.ClientBase,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const { firmId, engagementId, documentId } = opts;
  const llm = opts.llm ?? new LlmClient({ db });
  const readText = opts.readText ?? readDocumentText;

  const assessment = (
    await db.query(
      `select id, rubric_version_id from assessments
       where engagement_id = $1 and firm_id = $2 and status = 'in_progress'
       order by sequence_number desc limit 1`,
      [engagementId, firmId],
    )
  ).rows[0];
  if (!assessment) {
    throw new Error('engagement has no in-progress assessment to propose answers for');
  }
  const assessmentId: string = assessment.id;

  // The document must belong to this engagement (and firm) — a candidate can only
  // be sourced from a document the engagement actually holds.
  const docOk =
    (
      await db.query(`select id from documents where id = $1 and engagement_id = $2 and firm_id = $3`, [
        documentId,
        engagementId,
        firmId,
      ])
    ).rowCount === 1;
  if (!docOk) throw new Error('document does not belong to this engagement');

  const questions = (
    await db.query(
      `select q.code, q.prompt, q.answer_type from questions q
       join dimensions d on d.id = q.dimension_id
       where d.rubric_version_id = $1`,
      [assessment.rubric_version_id],
    )
  ).rows as { code: string; prompt: string; answer_type: string }[];
  const allowedCodes = new Set(questions.map((q) => q.code));

  const documentText = await readText(db, documentId);
  const questionsJson = JSON.stringify(
    questions.map((q) => ({ code: q.code, prompt: q.prompt, answer_type: q.answer_type })),
  );

  const res = await llm.call({
    promptKey: extractAnswerCandidatesV1.key,
    vars: { documentText, questionsJson },
    firmId,
    engagementId,
  });

  const candidates = parseAnswerCandidates(res.text, allowedCodes);

  const rows: AnswerCandidateRow[] = [];
  for (const c of candidates) {
    const inserted = (
      await db.query(
        `insert into answer_candidates
           (firm_id, engagement_id, assessment_id, question_code, candidate_value, confidence,
            source_document_id, source_span, status, model, prompt_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
         returning id, created_at`,
        [
          firmId,
          engagementId,
          assessmentId,
          c.question_code,
          JSON.stringify(c.value),
          c.confidence,
          documentId,
          c.source_span ?? null,
          res.model,
          PROMPT_VERSION,
        ],
      )
    ).rows[0];
    rows.push({
      id: inserted.id,
      engagement_id: engagementId,
      assessment_id: assessmentId,
      question_code: c.question_code,
      candidate_value: c.value,
      confidence: c.confidence,
      source_document_id: documentId,
      source_span: c.source_span ?? null,
      status: 'pending',
      model: res.model,
      prompt_version: PROMPT_VERSION,
      created_at:
        inserted.created_at instanceof Date ? inserted.created_at.toISOString() : String(inserted.created_at),
    });
  }

  return { assessment_id: assessmentId, proposed: rows.length, candidates: rows };
}

export interface ConfirmResult {
  candidate_id: string;
  assessment_id: string;
  question_code: string;
  source: 'document' | 'self_reported';
  status: 'confirmed';
}

// Promote a pending candidate to a real assessment answer — the ONE path from the
// staging queue into the scored `answers` table, gated on a human doing it. Uses
// the EXACT answer-writing SQL the manual intake / ledger sync use, so the DRS is
// still computed deterministically from a confirmed answer (rules 1 & 2). Stamps
// provenance `document` when the candidate's source document is a real firm
// document (the human is attesting to it), else `self_reported`. Refuses to write
// into a completed (immutable) assessment (rule 4).
export async function confirmAnswerCandidate(
  db: pg.ClientBase,
  candidateId: string,
  reviewerProfileId: string | null = null,
): Promise<ConfirmResult> {
  const cand = (
    await db.query(
      `select id, firm_id, engagement_id, assessment_id, question_code, candidate_value,
              source_document_id, status
       from answer_candidates where id = $1`,
      [candidateId],
    )
  ).rows[0];
  if (!cand) throw new Error('answer candidate not found');
  if (cand.status !== 'pending') throw new Error(`candidate is already ${cand.status}`);

  const a = (
    await db.query(`select id, firm_id, rubric_version_id, status from assessments where id = $1`, [
      cand.assessment_id,
    ])
  ).rows[0];
  if (!a) throw new Error('assessment not found');
  if (a.status === 'completed') throw new Error('assessment is completed and immutable');

  const questionId = (
    await db.query(
      `select q.id from questions q join dimensions d on d.id = q.dimension_id
       where d.rubric_version_id = $1 and q.code = $2`,
      [a.rubric_version_id, cand.question_code],
    )
  ).rows[0]?.id as string | undefined;
  if (!questionId) throw new Error(`question '${cand.question_code}' is not in this assessment's rubric`);

  // The candidate's source document counts as evidence only if it is a real
  // document in this firm; otherwise the confirmed answer is self_reported.
  let evidenceDocumentId: string | null = null;
  if (cand.source_document_id) {
    const ok =
      (
        await db.query(`select id from documents where id = $1 and firm_id = $2`, [
          cand.source_document_id,
          cand.firm_id,
        ])
      ).rowCount === 1;
    if (ok) evidenceDocumentId = cand.source_document_id;
  }
  const source: 'document' | 'self_reported' = evidenceDocumentId ? 'document' : 'self_reported';

  // The existing answer-writing path: upsert the answer, then stamp provenance.
  await db.query(
    `insert into answers (assessment_id, question_id, value) values ($1, $2, $3)
     on conflict (assessment_id, question_id) do update set value = excluded.value`,
    [cand.assessment_id, questionId, JSON.stringify(cand.candidate_value)],
  );
  await db.query(
    `insert into answer_provenance (firm_id, assessment_id, question_id, source, verified_at, evidence_document_id, verified_by)
     values ($1, $2, $3, $4, ${source === 'document' ? 'now()' : 'null'}, $5, $6)
     on conflict (assessment_id, question_id)
     do update set source = excluded.source, verified_at = excluded.verified_at,
                   evidence_document_id = excluded.evidence_document_id, verified_by = excluded.verified_by`,
    [cand.firm_id, cand.assessment_id, questionId, source, evidenceDocumentId, reviewerProfileId],
  );
  await logProvenanceEvent(db, {
    firmId: cand.firm_id,
    assessmentId: cand.assessment_id,
    questionId,
    source,
    evidenceDocumentId,
    event: 'answer_candidate_confirmed',
    actorProfileId: reviewerProfileId,
  });

  await db.query(
    `update answer_candidates set status = 'confirmed', reviewed_by = $2, reviewed_at = now() where id = $1`,
    [candidateId, reviewerProfileId],
  );

  return {
    candidate_id: candidateId,
    assessment_id: cand.assessment_id,
    question_code: cand.question_code,
    source,
    status: 'confirmed',
  };
}
