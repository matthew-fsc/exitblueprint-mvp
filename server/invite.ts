// Advisor-initiated owner invitation. Creates (or, under Clerk, invites) the
// owner and scopes them to the engagement's company so they can sign in to the
// portal. Runs with the service role; the caller is authorized against the
// engagement (their firm) before this is invoked.
//
// Two paths, chosen by env at runtime:
//   - CLERK (CLERK_SECRET_KEY set) — the production standard: send a Clerk
//     **organization invitation** (Clerk emails the link). The owner's profile is
//     provisioned on membership acceptance by the Clerk webhook (docs/30 §5),
//     carrying the company/role scope from the invitation's public_metadata — so
//     no profile row and no auth.users row are written here.
//   - DEV (local emulator, no Clerk key): insert the auth.users row directly; the
//     dev auth accepts it with the fixed dev password. Only this path returns
//     `dev_password`. Local/CI only.
//
// The hosted Supabase-Auth invite path (inviteUserByEmail) was removed when Clerk
// became the standard identity provider.
import type pg from 'pg';
import { clerkEnabled, createOrganizationInvitation, orgRoleForAppRole } from './clerk';

export interface InviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  // Present only on the dev path (no real email sent). The UI shows it behind
  // the dev-stack guard; production sends a Clerk invitation email.
  dev_password?: string;
}

// Where the invite link lands. Defaults to the CORS origin (the app), so a single
// FUNCTIONS_ALLOWED_ORIGIN is enough; override with OWNER_INVITE_REDIRECT_URL.
const INVITE_REDIRECT_URL = process.env.OWNER_INVITE_REDIRECT_URL ?? process.env.FUNCTIONS_ALLOWED_ORIGIN;

export async function inviteOwner(
  db: pg.ClientBase,
  engagementId: string,
  emailRaw: string,
  fullName: string | null,
): Promise<InviteResult> {
  const email = (emailRaw ?? '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('a valid email is required');

  const eng = (
    await db.query(`select firm_id, company_id from engagements where id = $1`, [engagementId])
  ).rows[0];
  if (!eng) throw new Error('engagement not found');

  // Already an owner for this company? Return it (idempotent, no duplicates). Use
  // a LEFT JOIN so it works whether or not an auth.users row exists (there is
  // none under Clerk, where identity lives in Clerk and user_id holds a Clerk id).
  const existing = (
    await db.query(
      `select coalesce(p.email, u.email) as email, p.full_name
       from profiles p left join auth.users u on u.id::text = p.user_id
       where p.company_id = $1 and p.role = 'owner' limit 1`,
      [eng.company_id],
    )
  ).rows[0];
  if (existing) return { status: 'exists', email: existing.email, full_name: existing.full_name };

  // CLERK path: send an organization invitation; the profile is provisioned by
  // the membership-created webhook (docs/30 §5). Needs the firm's Clerk org id.
  if (clerkEnabled()) {
    const orgId = (await db.query(`select clerk_org_id from firms where id = $1`, [eng.firm_id])).rows[0]?.clerk_org_id;
    if (!orgId) {
      throw new Error(
        'this firm has no Clerk organization yet (firms.clerk_org_id is unset) — provision it with scripts/admin.ts create-firm',
      );
    }
    await createOrganizationInvitation({
      orgId,
      email,
      role: orgRoleForAppRole('owner'),
      publicMetadata: { app_role: 'owner', company_id: eng.company_id, firm_id: eng.firm_id, full_name: fullName },
      redirectUrl: INVITE_REDIRECT_URL || undefined,
    });
    return { status: 'invited', email, full_name: fullName || null };
  }

  // DEV path (local emulator): create the auth.users row directly, then write the
  // profile. Login uses the fixed dev password.
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
    `insert into profiles (user_id, firm_id, role, company_id, full_name, email)
     values ($1, $2, 'owner', $3, $4, $5)`,
    [userId, eng.firm_id, eng.company_id, fullName || null, email],
  );

  return { status: 'invited', email, full_name: fullName || null, dev_password: 'demo' };
}
