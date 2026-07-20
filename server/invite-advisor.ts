// Firm-staff invitation — the self-serve counterpart to scripts/admin.ts
// create-advisor (docs/archive/35 blocker #1: provisioning was CLI-only). An advisor or
// admin invites another advisor / reviewer / admin into THEIR OWN firm; the
// caller's firm is resolved from their profile upstream (scope 'firm'), never
// from the request body, so a firm can only ever grow its own team.
//
// Two paths, chosen by env at runtime (mirrors server/invite.ts inviteOwner):
//   - CLERK (CLERK_SECRET_KEY set) — the production standard: send a Clerk
//     **organization invitation** (Clerk emails the link). The profile is
//     provisioned on membership acceptance by the Clerk webhook (docs/30 §5),
//     carrying the role scope from the invitation's public_metadata — so no
//     profile row and no auth.users row are written here.
//   - DEV (local emulator, no Clerk key): insert the auth.users row directly and
//     write the staff profile; the dev auth accepts it with the fixed dev
//     password. Only this path returns `dev_password`. Local/CI only.
//
// Seat enforcement: a firm's plan seat limit is honored only when billing is
// enforced (BILLING_ENFORCED=true), matching every other billing gate in the
// codebase (server/entitlements.ts) — beta/comped firms with no plan attached are
// unlimited. The seat *usage* is always returned so the UI can show "N of M".
import type pg from 'pg';
import { clerkEnabled, createOrganizationInvitation, orgRoleForAppRole, type AppRole } from './clerk';
// Use the PURE resolver (shared/) not server/entitlements: server/entitlements
// imports the registry, and the registry imports this module, so pulling it here
// would form an import cycle that leaves GATED_FNS uninitialized at load.
import { resolveEntitlement, withinLimit } from '../shared/entitlements';

// The staff roles a firm can invite. Owners are invited through the engagement
// flow (server/invite.ts), never here.
export type StaffRole = 'advisor' | 'reviewer' | 'admin';
const STAFF_ROLES: StaffRole[] = ['advisor', 'reviewer', 'admin'];

export interface InviteAdvisorResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  role: StaffRole;
  seatsUsed: number;
  seatLimit: number | null; // null = unlimited
  // Present only on the dev path (no real email sent). The UI shows it behind the
  // dev-stack guard; production sends a Clerk invitation email.
  dev_password?: string;
}

// Where the invite link lands. Same default as the owner invite (the app origin).
const INVITE_REDIRECT_URL = process.env.OWNER_INVITE_REDIRECT_URL ?? process.env.FUNCTIONS_ALLOWED_ORIGIN;

// Count the firm's staff seats in use (advisor/reviewer/admin profiles). Owners
// are company-scoped clients, not seats, so they are excluded.
async function countStaffSeats(db: pg.ClientBase, firmId: string): Promise<number> {
  const r = await db.query(
    `select count(*)::int c from profiles where firm_id = $1 and role = any($2)`,
    [firmId, STAFF_ROLES],
  );
  return r.rows[0]?.c ?? 0;
}

// Seats enforce only when billing is on (mirrors server/entitlements). Read as an
// env value here to avoid importing server/entitlements (import-cycle, see above).
function billingEnforced(): boolean {
  return process.env.BILLING_ENFORCED === 'true';
}

// The firm's plan seat limit (null = unlimited), resolved from the cached billing
// rows with the pure resolver. Inlines the small read server/entitlements does.
async function firmSeatLimit(db: pg.ClientBase, firmId: string): Promise<number | null> {
  const sub = (
    await db.query(`select plan_code, status, seats, comp from firm_subscriptions where firm_id = $1`, [firmId])
  ).rows[0];
  const plan = sub?.plan_code
    ? (await db.query(`select code, name, seat_limit, engagement_limit, features from plans where code = $1`, [sub.plan_code])).rows[0]
    : null;
  return resolveEntitlement(
    sub && { plan_code: sub.plan_code, status: sub.status, seats: sub.seats, comp: sub.comp },
    plan && {
      code: plan.code,
      name: plan.name,
      seat_limit: plan.seat_limit,
      engagement_limit: plan.engagement_limit,
      features: Array.isArray(plan.features) ? plan.features : [],
    },
  ).seatLimit;
}

export async function inviteAdvisor(
  db: pg.ClientBase,
  firmId: string,
  emailRaw: string,
  fullName: string | null,
  roleRaw: string,
): Promise<InviteAdvisorResult> {
  const email = (emailRaw ?? '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('a valid email is required');

  const role = (roleRaw ?? 'advisor') as StaffRole;
  if (!STAFF_ROLES.includes(role)) throw new Error(`role must be one of ${STAFF_ROLES.join(', ')}`);

  // Seat check. Only blocks when billing is enforced AND the plan sets a finite
  // limit; a comped/no-plan firm (seatLimit null) is unlimited. Usage is returned
  // in every case so the caller can render "N of M seats".
  const seatLimit = await firmSeatLimit(db, firmId);
  const seatsUsed = await countStaffSeats(db, firmId);
  if (billingEnforced() && !withinLimit(seatsUsed, seatLimit)) {
    throw new Error(
      `seat limit reached (${seatsUsed} of ${seatLimit}). Upgrade your plan in Settings → Billing to add advisors.`,
    );
  }

  // CLERK path: send an organization invitation; the profile is provisioned by
  // the membership-created webhook (docs/30 §5). Needs the firm's Clerk org id.
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
      role: orgRoleForAppRole(role as AppRole),
      publicMetadata: { app_role: role, firm_id: firmId, full_name: fullName },
      redirectUrl: INVITE_REDIRECT_URL || undefined,
    });
    return { status: 'invited', email, full_name: fullName || null, role, seatsUsed, seatLimit };
  }

  // DEV path (local emulator): create the auth.users row directly, then write the
  // staff profile. Login uses the fixed dev password. Idempotent: an email that
  // already has a profile returns `exists` (no duplicate, no seat consumed).
  let userId = (await db.query(`select id from auth.users where lower(email) = $1 limit 1`, [email])).rows[0]?.id;
  if (userId) {
    const existing = (await db.query(`select role from profiles where user_id = $1`, [userId])).rows[0];
    if (existing) {
      return {
        status: 'exists',
        email,
        full_name: fullName || null,
        role: existing.role as StaffRole,
        seatsUsed,
        seatLimit,
      };
    }
  } else {
    userId = (
      await db.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email])
    ).rows[0].id;
  }

  await db.query(
    `insert into profiles (user_id, firm_id, role, full_name, email)
     values ($1, $2, $3, $4, $5)`,
    [userId, firmId, role, fullName || null, email],
  );

  return {
    status: 'invited',
    email,
    full_name: fullName || null,
    role,
    seatsUsed: seatsUsed + 1,
    seatLimit,
    dev_password: 'demo',
  };
}
