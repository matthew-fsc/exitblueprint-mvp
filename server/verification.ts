// Phase 1: financial verification summary. Descriptive only — reads the
// provenance rows recorded against an assessment's financial inputs and reports
// what share are document- or ledger-backed. Never reads or writes a score.
//
// "Financial inputs" are the scored questions in the financial dimensions
// (Financial Integrity + Revenue Quality) — the figures a QuickBooks/Xero
// connect or a document review would substantiate. Provenance of `document` or
// `connected_ledger` counts as verified; `self_reported` does not.
import type pg from 'pg';

export type VerificationTier = 'self_reported' | 'partly_verified' | 'document_verified';

export interface VerificationInput {
  question_id: string;
  question_code: string;
  prompt: string;
  dimension_code: string;
  source: 'self_reported' | 'document' | 'connected_ledger';
}

export interface VerificationSummary {
  verified_inputs: number;
  total_inputs: number;
  pct: number; // 0–100, rounded
  tier: VerificationTier;
  inputs: VerificationInput[];
}

// Which dimensions carry ledger-substantiable figures.
const FINANCIAL_DIMENSIONS = ['FIN', 'REV'];

// Default tier thresholds (a product decision; neutral defaults for now).
export function tierFor(pct: number): VerificationTier {
  if (pct >= 67) return 'document_verified';
  if (pct >= 34) return 'partly_verified';
  return 'self_reported';
}

export async function verificationSummary(
  db: pg.ClientBase,
  assessmentId: string,
): Promise<VerificationSummary> {
  const assessment = (
    await db.query(`select rubric_version_id from assessments where id = $1`, [assessmentId])
  ).rows[0];
  if (!assessment) throw new Error(`assessment ${assessmentId} not found`);

  // The financial inputs for this rubric version, with any recorded provenance.
  const rows = (
    await db.query(
      `select q.id as question_id, q.code as question_code, q.prompt, d.code as dimension_code,
              coalesce(ap.source, 'self_reported') as source
       from questions q
       join dimensions d on d.id = q.dimension_id
       left join answer_provenance ap
         on ap.question_id = q.id and ap.assessment_id = $1
       where d.rubric_version_id = $2 and q.scored = true and d.code = any($3)
       order by d.code, q.sort_order`,
      [assessmentId, assessment.rubric_version_id, FINANCIAL_DIMENSIONS],
    )
  ).rows as VerificationInput[];

  const verified = rows.filter((r) => r.source === 'document' || r.source === 'connected_ledger').length;
  const total = rows.length;
  const pct = total > 0 ? Math.round((verified / total) * 100) : 0;

  return { verified_inputs: verified, total_inputs: total, pct, tier: tierFor(pct), inputs: rows };
}
