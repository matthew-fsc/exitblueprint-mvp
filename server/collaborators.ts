// Per-engagement, view-only external collaborators (CPA, attorney, …). This is
// the owner-portal invite workflow extended to a client's outside advisors: an
// engagement's "deal team" is assembled by emailing each person a portal link,
// and they land in a READ-ONLY view scoped to that single engagement.
//
// Two paths, chosen by env at runtime — identical in shape to server/invite.ts
// (inviteOwner) so the whole platform has one invitation model:
//   - CLERK (CLERK_SECRET_KEY set) — send a Clerk **organization invitation**
//     carrying { app_role: 'collaborator', engagement_id, company_id, firm_id }
//     in public_metadata. The profile is provisioned on acceptance by the Clerk
//     webhook (server/clerk-webhook.ts), which also flips the roster row to
//     'active'. No profile / auth.users row is written here.
//   - DEV (local emulator, no Clerk key) — insert the auth.users row + the
//     collaborator profile directly and mark the roster row 'active'. Only this
//     path returns `dev_password`. Local/CI only.
//
// The roster itself (engagement_collaborators) is always written here up-front so
// the advisor sees the invitee immediately (pending under Clerk, active in dev).
// Authorization is upstream: the caller is confirmed as firm staff who can see
// the engagement (scope 'manage-engagement'); firmId is trusted, never from body.
import type pg from 'pg';
import { clerkEnabled, createOrganizationInvitation } from './clerk';

export type CollaboratorKind = 'cpa' | 'attorney' | 'advisor' | 'other';
const KINDS: CollaboratorKind[] = ['cpa', 'attorney', 'advisor', 'other'];

export interface CollaboratorInviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  kind: CollaboratorKind;
  // Present only on the dev path (no real email sent); shown behind the dev guard.
  dev_password?: string;
}

// Where the invite link lands — same default as the owner invite (the app origin).
const INVITE_REDIRECT_URL = process.env.OWNER_INVITE_REDIRECT_URL ?? process.env.FUNCTIONS_ALLOWED_ORIGIN;

function normaliseKind(raw: string | null | undefined): CollaboratorKind {
  return KINDS.includes((raw ?? '') as CollaboratorKind) ? (raw as CollaboratorKind) : 'other';
}

export async function inviteCollaborator(
  db: pg.ClientBase,
  firmId: string,
  engagementId: string,
  emailRaw: string,
  fullName: string | null,
  kindRaw: string | null,
  invitedBy: string | null,
): Promise<CollaboratorInviteResult> {
  const email = (emailRaw ?? '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('a valid email is required');
  const kind = normaliseKind(kindRaw);
  const name = (fullName ?? '').trim() || null;

  // Trust firmId (resolved from the caller's staff profile); confirm the target
  // engagement belongs to it and read the company scope off it.
  const eng = (
    await db.query(`select company_id from engagements where id = $1 and firm_id = $2`, [engagementId, firmId])
  ).rows[0];
  if (!eng) throw new Error('engagement not found');

  // Already on this engagement's team (and not revoked)? Idempotent no-op.
  const existing = (
    await db.query(
      `select full_name, kind from engagement_collaborators
       where engagement_id = $1 and email = $2 and status <> 'revoked' limit 1`,
      [engagementId, email],
    )
  ).rows[0];
  if (existing) {
    return { status: 'exists', email, full_name: existing.full_name, kind: existing.kind as CollaboratorKind };
  }

  // Write (or reactivate) the roster row so the advisor sees the invitee at once.
  // invitedBy is the caller's profile id (provenance only, resolved upstream).
  await db.query(
    `insert into engagement_collaborators (firm_id, engagement_id, company_id, email, full_name, kind, status, invited_by)
     values ($1, $2, $3, $4, $5, $6, 'invited', $7)
     on conflict (engagement_id, email) do update
       set full_name = excluded.full_name, kind = excluded.kind,
           status = 'invited', revoked_at = null, user_id = null`,
    [firmId, engagementId, eng.company_id, email, name, kind, invitedBy],
  );

  // CLERK path: organization invitation; the webhook provisions the profile and
  // activates the roster row on acceptance.
  if (clerkEnabled()) {
    const orgId = (await db.query(`select clerk_org_id from firms where id = $1`, [firmId])).rows[0]?.clerk_org_id;
    if (!orgId) {
      throw new Error(
        'this firm has no Clerk organization yet (firms.clerk_org_id is unset) — provision it with scripts/admin.ts create-firm',
      );
    }
    await createOrganizationInvitation({
      orgId,
      email,
      role: 'org:member',
      publicMetadata: {
        app_role: 'collaborator',
        engagement_id: engagementId,
        company_id: eng.company_id,
        firm_id: firmId,
        full_name: name,
        email,
      },
      redirectUrl: INVITE_REDIRECT_URL || undefined,
    });
    return { status: 'invited', email, full_name: name, kind };
  }

  // DEV path: create the identity + collaborator profile directly, then activate.
  let userId = (await db.query(`select id from auth.users where lower(email) = $1 limit 1`, [email])).rows[0]?.id;
  if (userId) {
    const hasProfile = (await db.query(`select 1 from profiles where user_id = $1`, [userId])).rowCount;
    if (hasProfile) throw new Error('that email already has an account');
  } else {
    userId = (
      await db.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email])
    ).rows[0].id;
  }

  await db.query(
    `insert into profiles (user_id, firm_id, role, company_id, engagement_id, full_name, email)
     values ($1, $2, 'collaborator', $3, $4, $5, $6)`,
    [userId, firmId, eng.company_id, engagementId, name, email],
  );
  await db.query(
    `update engagement_collaborators set status = 'active', user_id = $1
     where engagement_id = $2 and email = $3`,
    [userId, engagementId, email],
  );

  return { status: 'invited', email, full_name: name, kind, dev_password: 'demo' };
}

// Revoke a collaborator's access. Marks the roster row revoked and deletes their
// provisioned profile (which is what actually cuts data access — with no profile,
// RLS resolves no role/engagement and every read returns nothing). The Clerk org
// membership, if any, is left in place; without a profile the app shows the
// "account isn't set up" gate. firmId is trusted; the row must belong to it.
export async function revokeCollaborator(
  db: pg.ClientBase,
  firmId: string,
  collaboratorId: string,
): Promise<{ ok: true }> {
  const row = (
    await db.query(`select user_id from engagement_collaborators where id = $1 and firm_id = $2`, [
      collaboratorId,
      firmId,
    ])
  ).rows[0];
  if (!row) throw new Error('collaborator not found');

  if (row.user_id) {
    await db.query(`delete from profiles where user_id = $1 and role = 'collaborator'`, [row.user_id]);
  }
  await db.query(
    `update engagement_collaborators set status = 'revoked', revoked_at = now(), user_id = null where id = $1`,
    [collaboratorId],
  );
  return { ok: true };
}
