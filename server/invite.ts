// Advisor-initiated owner invitation. Creates the owner's login and their
// owner profile (role owner, scoped to the engagement's company), so the owner
// can sign in to the portal. Runs with the service role; the caller is
// authorized against the engagement (their firm) before this is invoked.
//
// Two account-creation paths, chosen by env at runtime:
//   - PRODUCTION: when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, the new
//     owner is created via Supabase Auth admin `inviteUserByEmail`, which emails
//     a real set-password / magic-link invite (redirecting to the app origin).
//   - DEV / no admin creds: fall back to inserting the auth.users row directly;
//     the dev auth accepts any such email with the fixed dev password, so the
//     login works end-to-end without an email provider. Only this path returns
//     `dev_password`.
import type pg from 'pg';
import { createClient } from '@supabase/supabase-js';

export interface InviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  // Present only on the dev path (no real email sent). The UI shows it behind
  // the dev-stack guard; in production a set-password email is sent instead.
  dev_password?: string;
}

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Where the set-password link lands. Defaults to the CORS origin (the app), so a
// single FUNCTIONS_ALLOWED_ORIGIN is enough; override with OWNER_INVITE_REDIRECT_URL.
const INVITE_REDIRECT_URL = process.env.OWNER_INVITE_REDIRECT_URL ?? process.env.FUNCTIONS_ALLOWED_ORIGIN;

// True when the service can send a real invitation email via Supabase Auth admin.
function canSendInviteEmail(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

// Create the auth user for `email`, returning its id and whether a real email
// was sent. Production sends a Supabase invite email; dev inserts the row directly.
async function createAuthUser(
  db: pg.ClientBase,
  email: string,
  fullName: string | null,
): Promise<{ userId: string; emailed: boolean }> {
  if (canSendInviteEmail()) {
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

  // Already an owner for this company? Return it (idempotent, no duplicates).
  const existing = (
    await db.query(
      // profiles.user_id is now text (Clerk id); cast the legacy auth.users uuid
      // to join. Transitional — this whole path is replaced by Clerk organization
      // invitations in the Clerk invite slice (docs/24 A5).
      `select coalesce(p.email, u.email) as email, p.full_name
       from profiles p join auth.users u on u.id::text = p.user_id
       where p.company_id = $1 and p.role = 'owner' limit 1`,
      [eng.company_id],
    )
  ).rows[0];
  if (existing) return { status: 'exists', email: existing.email, full_name: existing.full_name };

  // Find or create the auth user for this email.
  let userId = (await db.query(`select id from auth.users where lower(email) = $1 limit 1`, [email])).rows[0]?.id;
  let emailed = false;
  if (userId) {
    const hasProfile = (await db.query(`select 1 from profiles where user_id = $1`, [userId])).rowCount;
    if (hasProfile) throw new Error('that email already has an account');
  } else {
    ({ userId, emailed } = await createAuthUser(db, email, fullName));
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
    // Only surface the dev password when we did NOT send a real invite email.
    ...(emailed ? {} : { dev_password: 'demo' }),
  };
}
