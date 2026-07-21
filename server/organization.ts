// Organization controls — firm-level administration performed by an admin.
// Currently: reassign which advisor owns an engagement. The engagements table's
// advisor_id is frozen against end-user roles by a trigger
// (20260721000500_admin_org_controls.sql), so this is the ONLY sanctioned path to
// change it — it runs as service_role (RLS + trigger bypassed) after validating
// that both the engagement and the target advisor belong to the caller's firm.
//
// Authorization is upstream: the 'admin' auth scope (server/functions.ts) confirms
// the caller is an admin and resolves firmId from their profile — never the body.
import type pg from 'pg';

export interface AssignEngagementResult {
  engagement_id: string;
  advisor_id: string | null;
  advisor_name: string | null;
}

// Reassign (or clear) an engagement's owning advisor. firmId is trusted; both the
// engagement and the new advisor must belong to it. Passing advisor_id = null
// unassigns the engagement.
export async function assignEngagement(
  db: pg.ClientBase,
  firmId: string,
  engagementId: string,
  advisorId: string | null,
): Promise<AssignEngagementResult> {
  if (!engagementId) throw new Error('engagement_id required');

  // The engagement must be in the caller's firm.
  const eng = (
    await db.query(`select id from engagements where id = $1 and firm_id = $2`, [engagementId, firmId])
  ).rows[0];
  if (!eng) throw new Error('engagement not found');

  // The new owner (if any) must be a staff profile in the SAME firm. Only
  // advisor/admin can own an engagement — reviewers and owners cannot.
  let advisorName: string | null = null;
  if (advisorId !== null) {
    const adv = (
      await db.query(
        `select id, full_name, email from profiles
         where id = $1 and firm_id = $2 and role = any (array['advisor','admin']::app_role[])`,
        [advisorId, firmId],
      )
    ).rows[0];
    if (!adv) throw new Error('advisor not found in this firm');
    advisorName = adv.full_name ?? adv.email ?? null;
  }

  await db.query(`update engagements set advisor_id = $1 where id = $2`, [advisorId, engagementId]);
  return { engagement_id: engagementId, advisor_id: advisorId, advisor_name: advisorName };
}
