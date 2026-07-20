// Clerk Backend API client + app<->Clerk mapping helpers.
//
// Clerk is the production identity provider (docs/30). This is the single place
// that talks to Clerk's Backend API — used by scripts/admin.ts (firm/advisor
// provisioning) and server/invite.ts (owner invitations). It follows the repo's
// existing raw-`fetch` pattern (no @clerk/backend dependency) and authenticates
// every request with CLERK_SECRET_KEY.
//
// Nothing here runs unless CLERK_SECRET_KEY is set: local dev and CI have no
// Clerk keys and stay on the dev-emulator path, so importing this module is
// always safe.

const CLERK_API_URL = (process.env.CLERK_API_URL ?? 'https://api.clerk.com/v1').replace(/\/+$/, '');
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

export type AppRole = 'admin' | 'advisor' | 'reviewer' | 'owner';

// Clerk is the identity provider exactly when its backend key is present.
export function clerkEnabled(): boolean {
  return Boolean(CLERK_SECRET_KEY);
}

// Map an app role to the Clerk organization role. profiles.role stays the source
// of truth for RLS (docs/30 §1.3); the Clerk role only governs org management, so
// an app `admin` becomes `org:admin` and everyone else `org:member`.
export function orgRoleForAppRole(role: AppRole): 'org:admin' | 'org:member' {
  return role === 'admin' ? 'org:admin' : 'org:member';
}

// Split a display name into Clerk's first/last fields. Everything after the first
// token is the last name; a blank name yields no fields (Clerk allows nameless
// users). Pure + exported for testing.
export function splitName(fullName: string | null | undefined): { first_name?: string; last_name?: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  const [first, ...rest] = parts;
  return rest.length ? { first_name: first, last_name: rest.join(' ') } : { first_name: first };
}

export interface ClerkError extends Error {
  status: number;
  clerkErrors?: Array<{ code?: string; message?: string; long_message?: string }>;
}

// One request to the Clerk Backend API. Surfaces Clerk's real error message
// (errors[0]) rather than a bare status code, and attaches status + the parsed
// error array so callers can special-case idempotent conflicts.
async function clerkFetch<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  if (!CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is not set — Clerk provisioning is unavailable');
  const res = await fetch(`${CLERK_API_URL}${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${CLERK_SECRET_KEY}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const errors = (data as { errors?: ClerkError['clerkErrors'] } | null)?.errors;
    const detail = errors?.[0]?.long_message ?? errors?.[0]?.message ?? text ?? 'unknown error';
    const err = new Error(`Clerk ${init.method} ${path} failed (${res.status}): ${detail}`) as ClerkError;
    err.status = res.status;
    err.clerkErrors = errors;
    throw err;
  }
  return data as T;
}

function hasClerkErrorCode(err: unknown, ...codes: string[]): boolean {
  const list = (err as ClerkError)?.clerkErrors;
  if (list?.some((e) => e.code && codes.includes(e.code))) return true;
  // Fall back to a message match when the code is absent.
  const msg = (err as Error)?.message ?? '';
  return codes.some((c) => msg.includes(c));
}

// Create a Clerk Organization (a firm). Only `name` is required by the Backend
// API; `created_by` is optional, so an org can be provisioned before any user.
export async function createOrganization(
  name: string,
  opts: { maxAllowedMemberships?: number } = {},
): Promise<{ id: string }> {
  return clerkFetch<{ id: string }>('/organizations', {
    method: 'POST',
    body: {
      name,
      ...(opts.maxAllowedMemberships ? { max_allowed_memberships: opts.maxAllowedMemberships } : {}),
    },
  });
}

// Look up a Clerk user by email (exact match). Returns null when none exists.
export async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  const users = await clerkFetch<Array<{ id: string }>>(
    `/users?email_address=${encodeURIComponent(email)}&limit=1`,
    { method: 'GET' },
  );
  return Array.isArray(users) && users.length ? users[0] : null;
}

// Find the Clerk user for `email`, creating one if absent. The created user has a
// verified email and no password requirement — they sign in via Clerk's enabled
// strategies (email code / password reset), not a preset password. Idempotent and
// race-safe: a concurrent "identifier already exists" falls back to the lookup.
export async function findOrCreateUser(
  email: string,
  fullName: string | null,
): Promise<{ id: string; created: boolean }> {
  const existing = await findUserByEmail(email);
  if (existing) return { id: existing.id, created: false };
  try {
    const user = await clerkFetch<{ id: string }>('/users', {
      method: 'POST',
      body: { email_address: [email], ...splitName(fullName), skip_password_requirement: true },
    });
    return { id: user.id, created: true };
  } catch (err) {
    if (hasClerkErrorCode(err, 'form_identifier_exists', 'duplicate_record')) {
      const found = await findUserByEmail(email);
      if (found) return { id: found.id, created: false };
    }
    throw err;
  }
}

// Add a user to an organization with the given org role. Treating an existing
// membership as success keeps provisioning idempotent (re-running is a no-op).
export async function addMembership(
  orgId: string,
  userId: string,
  role: 'org:admin' | 'org:member',
): Promise<void> {
  try {
    await clerkFetch(`/organizations/${orgId}/memberships`, {
      method: 'POST',
      body: { user_id: userId, role },
    });
  } catch (err) {
    if (hasClerkErrorCode(err, 'already_a_member_in_organization') || /already a member/i.test((err as Error).message)) {
      return;
    }
    throw err;
  }
}

// Send a Clerk organization invitation (used for owner invites, docs/30 §5). The
// company/role scope rides in public_metadata so the membership-created webhook
// can provision the owner's profile on acceptance.
export async function createOrganizationInvitation(args: {
  orgId: string;
  email: string;
  role: 'org:admin' | 'org:member';
  publicMetadata?: Record<string, unknown>;
  redirectUrl?: string;
}): Promise<void> {
  await clerkFetch(`/organizations/${args.orgId}/invitations`, {
    method: 'POST',
    body: {
      email_address: args.email,
      role: args.role,
      ...(args.publicMetadata ? { public_metadata: args.publicMetadata } : {}),
      ...(args.redirectUrl ? { redirect_url: args.redirectUrl } : {}),
    },
  });
}
