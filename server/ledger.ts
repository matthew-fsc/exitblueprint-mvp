// QuickBooks/Xero ledger integration + the honest manual-entry alternative.
//
// Two ways real financial figures get into an assessment:
//   1. A LIVE ledger sync (syncLedgerToAssessment) — real numbers pulled from the
//      connected accounting API, stamped connected_ledger. The API call lives in
//      pullLedgerFinancials; until it is wired (Phase 3, live OAuth), a connection
//      imports NOTHING. We never fabricate figures and never stamp
//      connected_ledger on data the ledger did not actually report.
//   2. MANUAL entry (enterManualFinancials) — the advisor/owner types or uploads
//      the figures. Stamped `document` when they attest the numbers come from real
//      financial statements/exports (verified), else `self_reported` (not). Honest
//      about where the number came from; never dressed up as a ledger pull.
import type pg from 'pg';

// The questions a connected ledger can answer (and the set a manual financial
// entry may fill). Contract terms, retention cohorts, and add-back judgment are
// NOT here — those always need separate input or documents.
export const LEDGER_DERIVABLE_CODES = [
  'REV-ANNUAL',
  'REV-TOP5-SHARES',
  'REV-RECUR-PCT',
  'FIN-RECON',
  'FIN-BASIS',
  'FIN-STATEMENTS',
] as const;

export interface LedgerPull {
  provider: string;
  org_name: string | null;
  values: Record<string, unknown>;
}

// Fetch real figures from the connected accounting API. This is the single seam
// the live Intuit/Xero integration plugs into (Phase 3). Until then a connection
// yields no figures — deliberately: we do not invent numbers, so nothing false
// is ever stamped connected_ledger. Returns null when there is no connection.
export async function pullLedgerFinancials(
  db: pg.ClientBase,
  companyId: string,
): Promise<LedgerPull | null> {
  const conn = (
    await db.query(
      `select provider, external_org_name from ledger_connections
       where company_id = $1 and status = 'connected'
       order by connected_at desc nulls last limit 1`,
      [companyId],
    )
  ).rows[0];
  if (!conn) return null;

  // TODO(phase-3, live OAuth): call the provider API with the stored token and
  // map its report figures onto LEDGER_DERIVABLE_CODES. Until wired, no figures.
  const values: Record<string, unknown> = {};
  return { provider: conn.provider, org_name: conn.external_org_name, values };
}

export interface LedgerSyncResult {
  filled: number;
  provider: string | null;
  question_codes: string[];
}

// Fill an in-progress assessment's ledger-derivable answers from figures the
// connected accounting API actually reports, marking each connected_ledger. Until
// the live API is wired (pullLedgerFinancials), this fills nothing rather than
// anything invented. Idempotent; other questions and hand edits are untouched.
export async function syncLedgerToAssessment(
  db: pg.ClientBase,
  assessmentId: string,
): Promise<LedgerSyncResult> {
  const a = (
    await db.query(
      `select id, firm_id, engagement_id, rubric_version_id, status from assessments where id = $1`,
      [assessmentId],
    )
  ).rows[0];
  if (!a) throw new Error(`assessment ${assessmentId} not found`);
  if (a.status === 'completed') throw new Error('assessment is completed and immutable');

  const companyId = (
    await db.query(`select company_id from engagements where id = $1`, [a.engagement_id])
  ).rows[0]?.company_id;
  if (!companyId) throw new Error('engagement not found');

  const pull = await pullLedgerFinancials(db, companyId);
  if (!pull) throw new Error('no connected ledger for this company — connect QuickBooks or Xero first');

  const qids = new Map<string, string>(
    (
      await db.query(
        `select q.id, q.code from questions q
         join dimensions d on d.id = q.dimension_id
         where d.rubric_version_id = $1`,
        [a.rubric_version_id],
      )
    ).rows.map((r) => [r.code as string, r.id as string]),
  );

  const filledCodes: string[] = [];
  for (const [code, value] of Object.entries(pull.values)) {
    const qid = qids.get(code);
    if (!qid) continue;
    await db.query(
      `insert into answers (assessment_id, question_id, value) values ($1, $2, $3)
       on conflict (assessment_id, question_id) do update set value = excluded.value`,
      [assessmentId, qid, JSON.stringify(value)],
    );
    await db.query(
      `insert into answer_provenance (firm_id, assessment_id, question_id, source, verified_at)
       values ($1, $2, $3, 'connected_ledger', now())
       on conflict (assessment_id, question_id)
       do update set source = 'connected_ledger', verified_at = now()`,
      [a.firm_id, assessmentId, qid],
    );
    filledCodes.push(code);
  }

  await db.query(`update ledger_connections set last_sync_at = now() where company_id = $1`, [companyId]);

  return { filled: filledCodes.length, provider: pull.provider, question_codes: filledCodes };
}

export interface ManualFinancialEntry {
  code: string;
  value: unknown;
}
export interface ManualFinancialsResult {
  filled: number;
  source: 'document' | 'self_reported';
  question_codes: string[];
}

// The honest manual/upload path (docs/10-production-readiness.md, Phase 3): the
// advisor or owner supplies the financial figures directly. When `documented` is
// true they attest the numbers come from real financial statements / an export
// (stamped `document` = verified); otherwise the figures are `self_reported`
// (not verified). This is the replacement for the removed fabricated-defaults
// import — a real number the customer stands behind, labeled for what it is.
// Restricted to the derivable financial codes; other questions use the intake.
export async function enterManualFinancials(
  db: pg.ClientBase,
  assessmentId: string,
  entries: ManualFinancialEntry[],
  documented: boolean,
): Promise<ManualFinancialsResult> {
  const a = (
    await db.query(
      `select id, firm_id, rubric_version_id, status from assessments where id = $1`,
      [assessmentId],
    )
  ).rows[0];
  if (!a) throw new Error(`assessment ${assessmentId} not found`);
  if (a.status === 'completed') throw new Error('assessment is completed and immutable');

  const source = documented ? 'document' : 'self_reported';
  const allowed = new Set<string>(LEDGER_DERIVABLE_CODES);
  const qids = new Map<string, string>(
    (
      await db.query(
        `select q.id, q.code from questions q
         join dimensions d on d.id = q.dimension_id
         where d.rubric_version_id = $1`,
        [a.rubric_version_id],
      )
    ).rows.map((r) => [r.code as string, r.id as string]),
  );

  const filled: string[] = [];
  for (const { code, value } of entries) {
    if (!allowed.has(code)) continue;
    const qid = qids.get(code);
    if (qid === undefined || value === undefined) continue;
    await db.query(
      `insert into answers (assessment_id, question_id, value) values ($1, $2, $3)
       on conflict (assessment_id, question_id) do update set value = excluded.value`,
      [assessmentId, qid, JSON.stringify(value)],
    );
    // `document` is verified (attested to real statements) → verified_at set;
    // `self_reported` is not → verified_at null. Never connected_ledger here.
    await db.query(
      `insert into answer_provenance (firm_id, assessment_id, question_id, source, verified_at)
       values ($1, $2, $3, $4, ${documented ? 'now()' : 'null'})
       on conflict (assessment_id, question_id)
       do update set source = excluded.source, verified_at = excluded.verified_at`,
      [a.firm_id, assessmentId, qid, source],
    );
    filled.push(code);
  }

  return { filled: filled.length, source, question_codes: filled };
}
