// Beta Requirement 1: data-rights capture. Creating a client engagement and
// recording its blocking engagement-agreement acceptance are one atomic act —
// the caller's asUser/transaction wraps both inserts, so an engagement is never
// persisted without its acceptance. The assessment-insert trigger is the DB
// backstop; this is the sanctioned application path.
import type pg from 'pg';
import {
  DEFAULT_AGREEMENT_BODY,
  DEFAULT_AGREEMENT_LABEL,
  DEFAULT_AGREEMENT_TITLE,
} from '../shared/agreement-template';
import { isCalendarDate, isExitWindow } from '../shared/engagement';

// Every firm needs at least one active engagement agreement before it can start
// an engagement (createEngagementWithAgreement requires it, and the UI blocks on
// it). Seed the default so a newly provisioned firm is never born in an
// unreachable state — the advisor can start onboarding immediately and replace
// the text later via `npm run admin -- create-agreement-version`. Idempotent on
// (firm_id, version_label); runs with the service role (RLS-bypassing) exactly
// like the rest of firm provisioning.
export async function ensureDefaultAgreementVersion(
  db: pg.ClientBase,
  firmId: string,
): Promise<void> {
  await db.query(
    `insert into agreement_versions (firm_id, version_label, title, body_md, status)
     values ($1, $2, $3, $4, 'active')
     on conflict (firm_id, version_label) do nothing`,
    [firmId, DEFAULT_AGREEMENT_LABEL, DEFAULT_AGREEMENT_TITLE, DEFAULT_AGREEMENT_BODY],
  );
}

export interface CreateEngagementInput {
  // Either an existing company the caller can see, OR a new company to create in
  // the same transaction (exactly one of the two).
  company_id?: string | null;
  new_company?: { name: string; industry?: string | null } | null;
  agreement_version_id: string;
  // Engagement setup captured up front (all optional; DB defaults apply when null).
  target_exit_window?: string | null;
  started_at?: string | null; // 'YYYY-MM-DD'; defaults to now() when omitted
  target_close_date?: string | null; // 'YYYY-MM-DD'
  signer_name?: string | null;
  consent?: {
    benchmarking?: boolean;
    anonymized_aggregation?: boolean;
    outcome_tracking?: boolean;
  };
}

// Runs with the service-role client after authorize() has confirmed the caller
// is an advisor in `firmId` and that `company_id` is visible to them. firm_id is
// taken from the trusted `firmId`, never from the body.
export async function createEngagementWithAgreement(
  db: pg.ClientBase,
  userId: string,
  firmId: string,
  body: Record<string, unknown>,
): Promise<{ engagement_id: string }> {
  const input = body as unknown as CreateEngagementInput;
  if (typeof input.agreement_version_id !== 'string') throw new Error('agreement_version_id required');

  // Exactly one of company_id (existing) / new_company (create in this txn).
  const hasCompanyId = typeof input.company_id === 'string';
  const newCompany = input.new_company;
  const hasNewCompany = !!newCompany && typeof newCompany.name === 'string';
  if (hasCompanyId === hasNewCompany) {
    throw new Error('provide exactly one of company_id or new_company');
  }
  if (hasNewCompany && !newCompany!.name.trim()) throw new Error('new_company.name required');

  // Setup fields are optional, but when present they must be well-formed so
  // downstream (targetExitDate, the trajectory) can rely on them.
  if (input.target_exit_window != null && !isExitWindow(input.target_exit_window)) {
    throw new Error('target_exit_window must be one of the standard bands');
  }
  const today = new Date().toISOString().slice(0, 10);
  if (input.started_at != null) {
    if (!isCalendarDate(input.started_at)) throw new Error('started_at must be a valid date');
    if (input.started_at > today) throw new Error('started_at cannot be in the future');
  }
  if (input.target_close_date != null) {
    if (!isCalendarDate(input.target_close_date)) throw new Error('target_close_date must be a valid date');
    const floor = input.started_at ?? today;
    if (input.target_close_date < floor) {
      throw new Error('target_close_date cannot be before the start date');
    }
  }

  // The acceptance must reference an active agreement version owned by the firm.
  const ver = await db.query(
    `select id from agreement_versions where id = $1 and firm_id = $2 and status = 'active'`,
    [input.agreement_version_id, firmId],
  );
  if (ver.rowCount !== 1) throw new Error('agreement version not found or not active for this firm');

  // For an existing company, confirm it belongs to the firm (defense in depth
  // beyond authorize()). A new company is created below under the trusted firmId.
  if (hasCompanyId) {
    const co = await db.query(`select id from companies where id = $1 and firm_id = $2`, [
      input.company_id,
      firmId,
    ]);
    if (co.rowCount !== 1) throw new Error('company not found in this firm');
  }

  const actor = (
    await db.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId])
  ).rows[0]?.id as string | undefined;

  const consent = input.consent ?? {};

  // The service connection autocommits per statement, so wrap the (optional)
  // company insert and both engagement inserts in one transaction: the company,
  // engagement, and its acceptance are created together or not at all.
  await db.query('begin');
  try {
    let companyId = input.company_id as string | undefined;
    if (hasNewCompany) {
      companyId = (
        await db.query(
          `insert into companies (firm_id, name, industry) values ($1, $2, $3) returning id`,
          [firmId, newCompany!.name.trim(), newCompany!.industry?.trim() || null],
        )
      ).rows[0].id as string;
    }

    const eng = await db.query(
      `insert into engagements (firm_id, company_id, advisor_id, target_exit_window,
                                started_at, target_close_date)
       values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6)
       returning id`,
      [
        firmId,
        companyId,
        actor ?? null,
        input.target_exit_window ?? null,
        input.started_at ?? null,
        input.target_close_date ?? null,
      ],
    );
    const engagementId = eng.rows[0].id as string;

    await db.query(
      `insert into engagement_agreements
         (firm_id, engagement_id, agreement_version_id, accepted_by, accepted_signer_name,
          consent_benchmarking, consent_anonymized_aggregation, consent_outcome_tracking)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        firmId,
        engagementId,
        input.agreement_version_id,
        actor ?? null,
        typeof input.signer_name === 'string' ? input.signer_name : null,
        !!consent.benchmarking,
        !!consent.anonymized_aggregation,
        !!consent.outcome_tracking,
      ],
    );

    await db.query('commit');
    return { engagement_id: engagementId };
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }
}
