// Clerk webhook → automatic provisioning. This is what makes onboarding
// hands-off (nobody runs scripts/admin.ts by hand): Clerk emits an event when an
// organization or membership is created, and this module verifies it and writes
// the matching firm / profile row.
//
// Two events are handled:
//   - organization.created        → upsert the firm (link firms.clerk_org_id)
//   - organizationMembership.created → provision the user's profile, scoped to
//     the firm (and, for owners, the company). The app role + company come from
//     the membership's public_metadata, which Clerk copies from the accepted
//     organization invitation (server/invite.ts sets app_role/company_id/firm_id/
//     full_name there); when metadata is absent (e.g. a member created straight in
//     Clerk) the app role is derived from the Clerk org role.
//
// Both writes are idempotent (Svix retries and replays are harmless), and both
// run with the service role — the webhook is a trusted system caller, not an
// end user, so it bypasses RLS exactly like scripts/admin.ts.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { AppRole } from './clerk';
import { ensureDefaultAgreementVersion } from './agreements';

const APP_ROLES: readonly AppRole[] = ['admin', 'advisor', 'reviewer', 'owner'];

function asAppRole(value: unknown): AppRole | null {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value)
    ? (value as AppRole)
    : null;
}

// Fallback when a membership carries no app_role metadata: mirror the Clerk org
// role. org:admin → admin; anything else → advisor (the default staff role).
function appRoleFromOrgRole(orgRole: string | undefined): AppRole {
  return orgRole === 'org:admin' ? 'admin' : 'advisor';
}

export interface SvixHeaders {
  svixId: string | undefined;
  svixTimestamp: string | undefined;
  svixSignature: string | undefined;
}

// Verify a Clerk (Svix) webhook signature against the raw request body. The
// signed content is `${id}.${timestamp}.${body}`; the secret is the base64 part
// of the `whsec_...` value; the header carries one or more space-separated
// `v1,<base64sig>` entries and the request is authentic if any matches. Pure and
// timing-safe — the security boundary for the endpoint, so it's unit-tested
// against Svix's published test vector.
export function verifyClerkWebhook(signingSecret: string, headers: SvixHeaders, rawBody: string): boolean {
  const { svixId, svixTimestamp, svixSignature } = headers;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const secretB64 = signingSecret.startsWith('whsec_') ? signingSecret.slice('whsec_'.length) : signingSecret;
  let key: Buffer;
  try {
    key = Buffer.from(secretB64, 'base64');
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const expected = createHmac('sha256', key).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest();

  // The header is a space-delimited list of "<version>,<signature>" pairs.
  for (const part of svixSignature.split(' ')) {
    const comma = part.indexOf(',');
    if (comma === -1) continue;
    const sig = part.slice(comma + 1);
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, 'base64');
    } catch {
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

// The subset of the Clerk event envelope we consume. `data` is the serialized
// object for the event type (organization / organization membership).
export interface ClerkEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface HandleResult {
  handled: boolean;
  detail: string;
}

// Provision (or no-op) from a verified Clerk event. Safe to call repeatedly for
// the same event — every write is idempotent.
export async function handleClerkEvent(db: pg.ClientBase, event: ClerkEvent): Promise<HandleResult> {
  switch (event.type) {
    case 'organization.created':
      return provisionFirm(db, event.data);
    case 'organizationMembership.created':
      return provisionMembership(db, event.data);
    default:
      return { handled: false, detail: `ignored event ${event.type}` };
  }
}

// organization.created → ensure a firm exists for the Clerk org. Idempotent:
// links an existing same-named firm that has no org yet (the admin.ts create-firm
// case, whose own insert already ran), otherwise inserts a new firm.
async function provisionFirm(db: pg.ClientBase, data: Record<string, unknown>): Promise<HandleResult> {
  const orgId = typeof data.id === 'string' ? data.id : null;
  const name = typeof data.name === 'string' ? data.name : null;
  if (!orgId || !name) return { handled: false, detail: 'organization.created missing id/name' };

  let firmId: string;
  let detail: string;
  const linked = (await db.query(`select id from firms where clerk_org_id = $1`, [orgId])).rows[0];
  if (linked) {
    firmId = linked.id as string;
    detail = `firm already linked to org ${orgId}`;
  } else {
    const byName = (await db.query(`select id from firms where name = $1 and clerk_org_id is null limit 1`, [name]))
      .rows[0];
    if (byName) {
      await db.query(`update firms set clerk_org_id = $2 where id = $1`, [byName.id, orgId]);
      firmId = byName.id as string;
      detail = `linked firm '${name}' (${byName.id}) to org ${orgId}`;
    } else {
      const created = (
        await db.query(`insert into firms (name, clerk_org_id) values ($1, $2) returning id`, [name, orgId])
      ).rows[0];
      firmId = created.id as string;
      detail = `created firm '${name}' (${created.id}) for org ${orgId}`;
    }
  }

  // A firm cannot start an engagement without an active agreement version (the
  // create-engagement handler and the UI both require it). Seed the default so
  // provisioning never leaves a firm in an unreachable state. Idempotent, and
  // also backfills a pre-existing firm that predates this seeding.
  await ensureDefaultAgreementVersion(db, firmId);
  return { handled: true, detail };
}

// organizationMembership.created → write the member's profile, scoped to the firm
// (and, for owners, the company). Idempotent on user_id.
async function provisionMembership(db: pg.ClientBase, data: Record<string, unknown>): Promise<HandleResult> {
  const organization = data.organization as { id?: string } | undefined;
  const publicUser = data.public_user_data as
    | { user_id?: string; identifier?: string; first_name?: string; last_name?: string }
    | undefined;
  const meta = (data.public_metadata as Record<string, unknown> | undefined) ?? {};

  const orgId = organization?.id;
  const userId = publicUser?.user_id;
  if (!orgId || !userId) return { handled: false, detail: 'membership missing organization/user id' };

  const firm = (await db.query(`select id from firms where clerk_org_id = $1`, [orgId])).rows[0];
  if (!firm) {
    // The organization.created event may not have been processed yet (or the firm
    // isn't ours). 5xx so Svix retries once the firm exists.
    throw new Error(`no firm linked to Clerk org ${orgId} yet`);
  }

  const role = asAppRole(meta.app_role) ?? appRoleFromOrgRole(typeof data.role === 'string' ? data.role : undefined);
  const companyId = typeof meta.company_id === 'string' ? meta.company_id : null;
  const email = typeof meta.email === 'string' ? meta.email : (publicUser?.identifier ?? null);
  const metaName = typeof meta.full_name === 'string' && meta.full_name.trim() ? meta.full_name : null;
  const derivedName = [publicUser?.first_name, publicUser?.last_name].filter(Boolean).join(' ').trim() || null;
  const fullName = metaName ?? derivedName;

  const inserted = (
    await db.query(
      `insert into profiles (user_id, firm_id, role, company_id, full_name, email)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id) do nothing
       returning id`,
      [userId, firm.id, role, companyId, fullName, email],
    )
  ).rowCount;

  return inserted
    ? { handled: true, detail: `provisioned ${role} profile for ${userId} in firm ${firm.id}` }
    : { handled: true, detail: `profile for ${userId} already exists` };
}
