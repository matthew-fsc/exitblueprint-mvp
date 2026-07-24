// Send the assessment to the client: the advisor-driven "share this in-progress
// assessment with the business owner" action, plus the owner's "I'm ready for
// review" signal back. See docs/02 (owner write path) and the
// share_assessment_with_client migration.
//
// Sharing (a) invites/provisions the owner if the company has no login yet
// (reusing inviteOwner — idempotent) and (b) stamps assessments.shared_with_client_at
// so owner RLS (owner_shared_intake_read / owner_shared_intake_answers) opens the
// questionnaire to the client. The advisor keeps full co-editing access throughout;
// only the advisor submits/scores (advisor-only submit, enforced by the
// 'assessment-staff' scope on score-assessment). Both handlers run with the service
// role; the caller is authorized upstream (share = staff via 'assessment-staff';
// submit = anyone who can see the assessment via 'assessment', re-verified here).
import type pg from 'pg';
import { inviteOwner, type InviteResult } from './invite';

export interface ShareResult {
  status: 'shared';
  shared_at: string;
  invite: InviteResult;
}

// Advisor shares an in-progress assessment with the owner. Invites the owner first
// (idempotent — returns { status: 'exists' } when one already exists), then marks
// the assessment shared so it appears, writable, in the owner's portal.
export async function shareAssessmentWithClient(
  db: pg.ClientBase,
  assessmentId: string,
  opts: { email: string | null; fullName: string | null },
): Promise<ShareResult> {
  const a = (
    await db.query(
      `select a.engagement_id, a.status, c.id as company_id, c.owner_contact_email, c.owner_contact_name
       from assessments a
       join engagements e on e.id = a.engagement_id
       join companies c on c.id = e.company_id
       where a.id = $1`,
      [assessmentId],
    )
  ).rows[0];
  if (!a) throw new Error('assessment not found');
  if (a.status !== 'in_progress')
    throw new Error('only an in-progress assessment can be shared with the client');

  // Invite the owner only if the company has no owner login yet. When one exists we
  // must NOT call inviteOwner — it validates the email before its own idempotent
  // check, so an empty email would throw even though nothing needs inviting. Mirror
  // its existing-owner lookup here. New invites prefer an explicit email/name from
  // the action, falling back to the informal owner contact on the company.
  const existing = (
    await db.query(
      `select coalesce(p.email, u.email) as email, p.full_name
       from profiles p left join auth.users u on u.id::text = p.user_id
       where p.company_id = $1 and p.role = 'owner' limit 1`,
      [a.company_id],
    )
  ).rows[0];
  const invite: InviteResult = existing
    ? { status: 'exists', email: existing.email, full_name: existing.full_name }
    : await inviteOwner(
        db,
        a.engagement_id as string,
        (opts.email ?? a.owner_contact_email ?? '') as string,
        (opts.fullName ?? a.owner_contact_name ?? null) as string | null,
      );

  const shared = (
    await db.query(
      `update assessments
       set shared_with_client_at = coalesce(shared_with_client_at, now())
       where id = $1
       returning shared_with_client_at`,
      [assessmentId],
    )
  ).rows[0];

  return { status: 'shared', shared_at: shared.shared_with_client_at, invite };
}

export interface SubmitResult {
  status: 'submitted';
  submitted_at: string;
}

// Owner (or advisor) signals the client has finished a first pass — "ready for
// review". Writes only the flag; scoring stays advisor-only. Re-verifies the
// assessment is actually shared and still in progress so this can't be used to
// stamp a completed or unshared assessment the caller happens to see.
export async function submitClientIntake(db: pg.ClientBase, assessmentId: string): Promise<SubmitResult> {
  const a = (
    await db.query(`select status, shared_with_client_at from assessments where id = $1`, [assessmentId])
  ).rows[0];
  if (!a) throw new Error('assessment not found');
  if (a.status !== 'in_progress' || !a.shared_with_client_at)
    throw new Error('assessment is not open for client intake');

  const submitted = (
    await db.query(
      `update assessments
       set client_submitted_at = coalesce(client_submitted_at, now())
       where id = $1 and status = 'in_progress'
       returning client_submitted_at`,
      [assessmentId],
    )
  ).rows[0];

  return { status: 'submitted', submitted_at: submitted.client_submitted_at };
}
