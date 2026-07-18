// Advisor-initiated owner invitation. Creates the owner's login and their
// owner profile (role owner, scoped to the engagement's company), so the owner
// can sign in to the portal. Runs with the service role; the caller is
// authorized against the engagement (their firm) before this is invoked.
//
// PRODUCTION: replace the auth.users insert with Supabase Auth admin
// inviteUserByEmail (which emails a set-password / magic link). In this build
// the dev auth accepts any auth.users email with the fixed dev password, so
// creating the user row is enough to make the login work end-to-end.
import type pg from 'pg';

export interface InviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  dev_password?: string;
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
