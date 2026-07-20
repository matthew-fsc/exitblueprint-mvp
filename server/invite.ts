// Advisor-initiated owner invitation. Creates (or, under Clerk, invites) the
// owner and scopes them to the engagement's company so they can sign in to the
// portal. Runs with the service role; the caller is authorized against the
// engagement (their firm) before this is invoked.
//
// Three paths, chosen by env at runtime:
//   - CLERK (CLERK_SECRET_KEY set): send a Clerk **organization invitation**
//     (Clerk emails the link). The owner's profile row is provisioned on
//     membership acceptance by the Clerk webhook (docs/30 A5), carrying the
//     company/role scope from the invitation's public_metadata — so no profile
//     row and no auth.users row are written here.
//   - SUPABASE ADMIN (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY): create the user
//     via Supabase Auth admin inviteUserByEmail (real set-password email) and
//     write the profile row.
//   - DEV: insert the auth.users row directly; the dev auth accepts it with the
//     fixed dev password. Only this path returns `dev_password`.
import type pg from 'pg';
import { createClient } from '@supabase/supabase-js';

export interface InviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  // Present only on the dev path (no real email sent). The UI shows it behind
  // the dev-stack guard; production sends a set-password / invitation email.
  dev_password?: string;
}

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const CLERK_API_URL = (process.env.CLERK_API_URL ?? 'https://api.clerk.com/v1').replace(/\/$/, '');
// Where the invite link lands. Defaults to the CORS origin (the app), so a single
// FUNCTIONS_ALLOWED_ORIGIN is enough; override with OWNER_INVITE_REDIRECT_URL.
const INVITE_REDIRECT_URL = process.env.OWNER_INVITE_REDIRECT_URL ?? process.env.FUNCTIONS_ALLOWED_ORIGIN;

function canSendSupabaseInvite(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

// Send a Clerk organization invitation. The company/role scope rides in
// public_metadata so the membership-created webhook can provision the profile.
async function inviteOwnerViaClerk(
  orgId: string,
  email: string,
  fullName: string | null,
  companyId: string,
  firmId: string,
): Promise<InviteResult> {
  const res = await fetch(`${CLERK_API_URL}/organizations/${orgId}/invitations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CLERK_SECRET_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      email_address: email,
      role: 'org:member',
      public_metadata: { app_role: 'owner', company_id: companyId, firm_id: firmId, full_name: fullName },
      redirect_url: INVITE_REDIRECT_URL || undefined,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Clerk organization invitation failed (${res.status}): ${detail}`);
  }
  return { status: 'invited', email, full_name: fullName };
}

// Create the auth user for `email` (Supabase paths), returning its id and whether
// a real email was sent. Admin path sends a Supabase invite email; dev inserts
// the row directly.
async function createSupabaseAuthUser(
  db: pg.ClientBase,
  email: string,
  fullName: string | null,
): Promise<{ userId: string; emailed: boolean }> {
  if (canSendSupabaseInvite()) {
    const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: fullName ? { full_name: fullName } : undefined,
      redirectTo: INVITE_REDIRECT_URL || undefined,
    });
    if (error || !data?.user) throw new Error(`could not send owner invite email: ${error?.message ?? 'unknown error'}`);
    return { userId: data.user.id, emailed: true };
  }
  const userId = (
    await db.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email])
  ).rows[0].id;
  return { userId, emailed: false };
}

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
  // the membership-created webhook (docs/30 A5). Needs the firm's Clerk org id.
  if (CLERK_SECRET_KEY) {
    const orgId = (await db.query(`select clerk_org_id from firms where id = $1`, [eng.firm_id])).rows[0]?.clerk_org_id;
    if (!orgId) {
      throw new Error('this firm has no Clerk organization yet (firms.clerk_org_id is unset) — see docs/30 A5');
    }
    return inviteOwnerViaClerk(orgId, email, fullName || null, eng.company_id, eng.firm_id);
  }

  // SUPABASE / DEV path: find or create the auth user, then write the profile row.
  let userId = (await db.query(`select id from auth.users where lower(email) = $1 limit 1`, [email])).rows[0]?.id;
  let emailed = false;
  if (userId) {
    const hasProfile = (await db.query(`select 1 from profiles where user_id = $1`, [userId])).rowCount;
    if (hasProfile) throw new Error('that email already has an account');
  } else {
    ({ userId, emailed } = await createSupabaseAuthUser(db, email, fullName));
  }

  await db.query(
    `insert into profiles (user_id, firm_id, role, company_id, full_name, email)
     values ($1, $2, 'owner', $3, $4, $5)`,
    [userId, eng.firm_id, eng.company_id, fullName || null, email],
  );

  return {
    status: 'invited',
    email,
    full_name: fullName || null,
    // Only surface the dev password when we did NOT send a real email.
    ...(emailed ? {} : { dev_password: 'demo' }),
  };
}
