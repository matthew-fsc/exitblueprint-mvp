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
  company_id: string;
  agreement_version_id: string;
  target_exit_window?: string | null;
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
  if (typeof input.company_id !== 'string') throw new Error('company_id required');
  if (typeof input.agreement_version_id !== 'string') throw new Error('agreement_version_id required');

  // The acceptance must reference an active agreement version owned by the firm.
  const ver = await db.query(
    `select id from agreement_versions where id = $1 and firm_id = $2 and status = 'active'`,
    [input.agreement_version_id, firmId],
  );
  if (ver.rowCount !== 1) throw new Error('agreement version not found or not active for this firm');

  // The company must belong to the firm (defense in depth beyond authorize()).
  const co = await db.query(`select id from companies where id = $1 and firm_id = $2`, [
    input.company_id,
    firmId,
  ]);
  if (co.rowCount !== 1) throw new Error('company not found in this firm');

  const actor = (
    await db.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId])
  ).rows[0]?.id as string | undefined;

  const consent = input.consent ?? {};

  // The service connection autocommits per statement, so wrap both inserts in
  // one transaction: the engagement must never persist without its acceptance.
  await db.query('begin');
  try {
    const eng = await db.query(
      `insert into engagements (firm_id, company_id, advisor_id, target_exit_window)
       values ($1, $2, $3, $4) returning id`,
      [firmId, input.company_id, actor ?? null, input.target_exit_window ?? null],
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
