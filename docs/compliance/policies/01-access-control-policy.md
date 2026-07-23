# Access Control Policy

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually / on material change · **Applies to:** all Exit Blueprint personnel and systems.

## Purpose

Define how identities are established, authenticated, authorized, reviewed, and
revoked across the Exit Blueprint platform, so that every actor has only the
access their role requires and tenant data stays isolated. This policy is the
access-control control set for our SOC 2 Security (Common Criteria) scope.

## Scope

All human and machine access to the Exit Blueprint application, its production
data plane (Supabase Postgres + Storage, the Node compute service, the React
SPA), the identity provider (Clerk), and the administrative tooling that
provisions them. Covers Exit Blueprint personnel, advisor-firm users, and
client/owner users. Infrastructure-layer access controls at our managed
providers (Supabase, Render, Vercel, Clerk) are inherited from those providers'
own attested controls and are not re-implemented here.

## Policy statements

1. **Delegated identity.** Authentication is delegated to Clerk, the standard
   identity provider. The application handles no passwords itself. Clerk
   Organizations map to firms; Clerk issues session JWTs verified by the compute
   service against JWKS.
2. **Role-based access control.** Access is granted through a fixed set of roles,
   each with a defined reach: **platform admin** (firm-scoped staff role),
   **advisor**, **reviewer**, and **client/owner**. A separate **platform
   superadmin** tier sits above all firm roles for global methodology operations
   (see #7). No ad-hoc grants outside these roles.
3. **Least privilege.** Every actor receives the minimum access for their role.
   Cross-tenant reach is never granted to a firm-scoped role. New capabilities
   default to deny.
4. **Tenant isolation enforced in the database.** Every domain table carries
   `firm_id` and is protected by Postgres row-level security; a firm reads and
   writes only its own rows. Isolation is enforced at the database layer, not
   only in application code.
5. **MFA required for privileged users.** TOTP multi-factor authentication is
   required for all advisor and platform-admin accounts, enforced at sign-in by
   Clerk policy.
6. **Session management.** Signed-in sessions terminate automatically after 30
   minutes of inactivity. Session tokens are validated on every request by
   signature and expiry.
7. **Privileged / superadmin access is default-deny and allowlisted.** Global
   methodology endpoints (rubric versions, dimensions, valuation rules — data
   with no `firm_id`) are reachable only by Clerk user ids on the
   `PLATFORM_SUPERADMIN_IDS` allowlist, checked server-side. Unset means nobody
   is a superadmin.
8. **Service-role and database credentials are tightly held.** The RLS-bypassing
   Supabase service role and the direct `DATABASE_URL` are used only by the
   server-side compute service, supplied via managed secret stores, never
   committed to source, and never exposed to the browser.
9. **Provisioning and deprovisioning are controlled.** Firm and advisor accounts
   are created and removed only through the admin tooling and the Clerk
   provisioning webhook. Access is revoked promptly on personnel or engagement
   termination.
10. **Periodic access review.** Access rights and the superadmin allowlist are
    reviewed on a recurring cadence with recorded dates.

## Roles & responsibilities

- **Security officer (Matthew):** owns this policy, maintains the
  `PLATFORM_SUPERADMIN_IDS` allowlist, performs and records access reviews,
  approves role assignments.
- **Platform admins (firm staff):** manage their own firm's advisors and clients
  within RLS scope; hold no cross-tenant reach.
- **Advisors / reviewers:** operate within their firm's data only.
- **Clients/owners:** access only their own engagement data.
- **All personnel:** protect credentials, use MFA, report suspected access
  issues.

## Implementation / evidence

- ✅ **Delegated auth / JWT verification** — `server/auth-jwt.ts` verifies Clerk
  (or legacy HS256) JWTs by signature and expiry, requires a `sub` claim; no
  in-app password handling.
- ✅ **RBAC + tenant isolation via RLS** — `firm_id` on every domain table with
  RLS policies; verified by the automated isolation suite `npm run test:rls`
  (`scripts/rls-test.ts`), run in CI on every PR.
- ✅ **MFA (TOTP) for advisor/admin** — enforced at sign-in via Clerk MFA policy.
  (The local dev emulator bypasses MFA; production enforces it.)
- ✅ **30-minute idle session timeout** — `src/lib/auth.tsx` (`IDLE_TIMEOUT_MS`).
- ✅ **Superadmin allowlist, default-deny** — `server/platform-admin.ts`
  (`PLATFORM_SUPERADMIN_IDS`, `isPlatformSuperadmin`); gate applied in
  `server/http.ts`. Unset → 403.
- ✅ **Service-role / DATABASE_URL secrecy** — service-role Supabase client used
  only server-side; secrets from Render/Vercel/CI secret stores, `.env` files
  git-ignored.
- 📄 **Provisioning / deprovisioning** — `scripts/admin.ts` (create-firm → Clerk
  Organization; create-advisor → Clerk user + membership + profile) and the
  Clerk provisioning webhook (`server/clerk-webhook.ts`, signature-verified).
- 🟡 **Periodic access review with recorded dates** — cadence defined here but
  not yet operationalized as a recurring, dated review (facts-brief gap #7).

## Exceptions

The local development emulator bypasses Clerk and MFA and is for local/CI use
only; it is never a production path. Any other exception to this policy requires
written approval from the security officer and is time-boxed and recorded.

## Review & enforcement

Reviewed at least annually and on material change to the identity model, roles,
or hosting. Violations (shared credentials, disabled MFA, unauthorized grants)
are remediated immediately and may result in access revocation. Enforcement is
primarily technical (RLS, JWT verification, allowlist) and secondarily
procedural.

## SOC 2 mapping

Supports Common Criteria **CC6.1** (logical access — identity and
authentication), **CC6.2** (registration/provisioning and deprovisioning), and
**CC6.3** (role-based authorization and least privilege). Cross-references:
`docs/compliance/policies/11-logging-monitoring-policy.md`,
`docs/13-security-summary.md`, `docs/16-vendor-security-dd.md`.
