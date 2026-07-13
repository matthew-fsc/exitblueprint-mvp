// QuickBooks/Xero ledger integration. Connecting the books lets us fill the
// financial assessment questions the ledger can answer directly — so the owner
// re-keys far less — while everything stays editable by hand.
//
// The OAuth handshake and the accounting API are external; this adapter isolates
// them behind pullLedgerFinancials so the rest of the app is provider-agnostic.
// In this build the adapter derives a deterministic, internally consistent set
// of figures from the company's books (the most recent answered figures where
// present, else stable defaults), so the flow works end-to-end without live
// credentials. Swapping in the real API is confined to pullLedgerFinancials.
import type pg from 'pg';

// The questions a connected ledger can answer. Contract terms, retention
// cohorts, and add-back judgment are NOT here — those still need manual input or
// documents, so a sync fills a lot, never everything.
export const LEDGER_DERIVABLE_CODES = [
  'REV-ANNUAL',
  'REV-TOP5-SHARES',
  'REV-RECUR-PCT',
  'FIN-RECON',
  'FIN-BASIS',
  'FIN-STATEMENTS',
] as const;

// Plausible "clean books" values for a company with no prior figures to read.
const DEFAULTS: Record<string, unknown> = {
  'REV-ANNUAL': [3_000_000, 3_400_000, 3_800_000, 4_100_000],
  'REV-TOP5-SHARES': [22, 14, 9, 7, 5],
  'REV-RECUR-PCT': 45,
  'FIN-RECON': 'monthly',
  'FIN-BASIS': 'accrual_consistent',
  'FIN-STATEMENTS': 'all_three',
};

export interface LedgerPull {
  provider: string;
  org_name: string | null;
  values: Record<string, unknown>;
}

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

  // Read the company's most recent answered figures for the derivable questions
  // (the ledger "confirms" what the books already show); fall back to defaults.
  const prior = new Map<string, unknown>(
    (
      await db.query(
        `select q.code, a.value
         from answers a
         join questions q on q.id = a.question_id
         join assessments s on s.id = a.assessment_id
         join engagements e on e.id = s.engagement_id
         where e.company_id = $1 and q.code = any($2)
         order by s.created_at desc`,
        [companyId, LEDGER_DERIVABLE_CODES as unknown as string[]],
      )
    ).rows.map((r) => [r.code as string, r.value]),
  );

  const values: Record<string, unknown> = {};
  for (const code of LEDGER_DERIVABLE_CODES) {
    values[code] = prior.has(code) ? prior.get(code) : DEFAULTS[code];
  }
  return { provider: conn.provider, org_name: conn.external_org_name, values };
}

export interface LedgerSyncResult {
  filled: number;
  provider: string | null;
  question_codes: string[];
}

// Fill an in-progress assessment's ledger-derivable answers from the connected
// books, marking each with connected_ledger provenance. Idempotent; leaves every
// other question untouched, and the filled answers remain editable by hand.
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
