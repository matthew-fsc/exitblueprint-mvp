// Portable function router — the deployable heart of the compute layer, and the
// Identity Engine's guarded gateway (architecture doc §02–03). Every
// `/functions/v1/<name>` endpoint the frontend calls is authorized and dispatched
// here, with NO dependency on the HTTP transport or on Vite. The dev emulator
// (dev/supabase-dev-server.ts) mounts this; a production host — a Supabase Edge
// Function or a small Node service (server/http.ts) — mounts the exact same logic
// by supplying a FunctionContext.
//
// What lives here vs. server/registry.ts: this file is the *gateway* — it verifies
// who is asking (via the host-supplied context), authorizes the call through RLS,
// applies the billing gate, and dispatches. WHICH function exists, which engine it
// belongs to, which auth scope gates it, and what it does are declared once in the
// registry. Adding a function never touches this file; it is a single registry
// entry. That is the structural modularity that makes the six-engine model
// (docs/28-architecture-map.md) a property of the code.
//
// The only runtime coupling left is the Postgres client shape (`pg.ClientBase`,
// i.e. anything with `.query`). Node hosts pass a real pg client; a Deno/Edge port
// passes an npm:pg (or compatible) client with the same `.query` surface — the
// business logic does not change.
import type pg from 'pg';
import { REGISTRY, err, type AuthScope, type FunctionResult, type FunctionSpec } from './registry';
import { entitlementGate } from './entitlements';
import { isPlatformSuperadmin } from './platform-admin';

export type { FunctionResult } from './registry';

// What the host must provide: the caller's id, an RLS-scoped runner (queries run
// AS the caller so real row-level security applies), and a service-role client
// (RLS bypassed) for the privileged work an edge function would do.
export interface FunctionContext {
  userId: string;
  asUser<T>(fn: (db: pg.ClientBase) => Promise<T>): Promise<T>;
  service: pg.ClientBase;
}

// Resolve the caller's own firm from their profile — NEVER from the request body,
// so the browser cannot ask for another firm's data (architecture doc §03). The
// `roles` set names which profile roles may act through this scope.
async function firmFromProfile(ctx: FunctionContext, roles: string[]): Promise<string | null> {
  return ctx.asUser(async (c) => {
    const r = await c.query(
      `select firm_id from profiles where user_id = $1 and role = any($2)`,
      [ctx.userId, roles],
    );
    return (r.rows[0]?.firm_id as string | undefined) ?? null;
  });
}

// Is a row with this id visible to the caller under RLS? (rowCount === 1)
async function visibleUnderRls(ctx: FunctionContext, table: string, id: string): Promise<boolean> {
  return ctx.asUser(async (c) => (await c.query(`select id from ${table} where id = $1`, [id])).rowCount === 1);
}

// Authorize a call through RLS, per the scope its registry entry declares, and
// return the caller's firm id when the scope resolves one (null otherwise).
// Returns a FunctionResult on failure (to short-circuit). Each branch is the same
// explicit, auditable logic the prior switch used — now keyed by the declared
// scope instead of scattered Set membership.
//
// `admin` is firm staff (docs/31, #65: admins have firm-scoped RLS on every
// domain table, and the frontend routes them to the advisor/staff surfaces —
// RequireAdvisor admits advisor+admin, RequireStaff admits advisor+reviewer+
// admin). So the role lists here include admin wherever advisor/reviewer are
// accepted; omitting it rejected admins from function calls the frontend and RLS
// both already permit (surfacing as "advisor or reviewer profile required").
// This grants no access beyond RLS — firmFromProfile still reads through asUser.
async function authorize(
  scope: AuthScope,
  body: Record<string, unknown>,
  ctx: FunctionContext,
): Promise<{ error: FunctionResult } | { firmId: string | null }> {
  switch (scope) {
    case 'firm': {
      // Firm-scoped readouts: resolve the caller's own firm from their advisor/
      // admin profile.
      const firmId = await firmFromProfile(ctx, ['advisor', 'admin']);
      if (!firmId) return { error: err(403, 'advisor profile required') };
      return { firmId };
    }
    case 'admin': {
      // Org administration (team, engagement ownership): resolve the caller's firm
      // from an ADMIN-only profile. Advisors are rejected here even though they
      // have firm-scoped data access — these are org controls, not client work.
      const firmId = await firmFromProfile(ctx, ['admin']);
      if (!firmId) return { error: err(403, 'firm admin required') };
      return { firmId };
    }
    case 'create-engagement': {
      // Resolve the caller's own advisor firm. The engagement doesn't exist yet,
      // so it can't be authorized by its own id. Two shapes: an existing company
      // (confirm it's visible under RLS) or a brand-new company (created server
      // side under the trusted firmId, so there's nothing to RLS-check yet).
      const firmId = await firmFromProfile(ctx, ['advisor', 'admin']);
      if (!firmId) return { error: err(403, 'advisor profile required') };
      const companyId = typeof body.company_id === 'string' ? body.company_id : null;
      const hasNewCompany =
        !!body.new_company && typeof (body.new_company as { name?: unknown }).name === 'string';
      if (!companyId && !hasNewCompany) return { error: err(400, 'company_id or new_company required') };
      if (companyId && !(await visibleUnderRls(ctx, 'companies', companyId))) {
        return { error: err(404, 'company not found') };
      }
      return { firmId };
    }
    case 'delete-engagement': {
      // Destructive: only firm staff who own the engagement may delete it.
      // Resolve the caller's advisor/admin firm (so owners/reviewers are
      // rejected), then confirm the target engagement is visible under RLS.
      const firmId = await firmFromProfile(ctx, ['advisor', 'admin']);
      if (!firmId) return { error: err(403, 'advisor profile required') };
      const engId = typeof body.engagement_id === 'string' ? body.engagement_id : null;
      if (!engId) return { error: err(400, 'engagement_id required') };
      if (!(await visibleUnderRls(ctx, 'engagements', engId))) return { error: err(404, 'engagement not found') };
      return { firmId };
    }
    case 'export-engagement': {
      // Read-only firm-data export: same authorization surface as delete — only
      // firm staff (advisor/admin) who own the engagement may take a full copy of
      // its data out. Resolve the caller's advisor/admin firm, then confirm the
      // target engagement is visible under RLS.
      const firmId = await firmFromProfile(ctx, ['advisor', 'admin']);
      if (!firmId) return { error: err(403, 'advisor profile required') };
      const engId = typeof body.engagement_id === 'string' ? body.engagement_id : null;
      if (!engId) return { error: err(400, 'engagement_id required') };
      if (!(await visibleUnderRls(ctx, 'engagements', engId))) return { error: err(404, 'engagement not found') };
      return { firmId };
    }
    case 'document-upload': {
      // Staff = advisor or reviewer; resolve the firm, then confirm the target
      // engagement is visible under RLS (upload attaches to an engagement).
      const firmId = await firmFromProfile(ctx, ['advisor', 'reviewer', 'admin']);
      if (!firmId) return { error: err(403, 'advisor or reviewer profile required') };
      const engId = typeof body.engagement_id === 'string' ? body.engagement_id : null;
      if (!engId) return { error: err(400, 'engagement_id required') };
      if (!(await visibleUnderRls(ctx, 'engagements', engId))) return { error: err(404, 'engagement not found') };
      return { firmId };
    }
    case 'review-queue': {
      // Staff; firm-scoped, no id — the queue is the caller's whole firm.
      const firmId = await firmFromProfile(ctx, ['advisor', 'reviewer', 'admin']);
      if (!firmId) return { error: err(403, 'advisor or reviewer profile required') };
      return { firmId };
    }
    case 'document': {
      // Staff; confirm the referenced document is visible under RLS.
      const firmId = await firmFromProfile(ctx, ['advisor', 'reviewer', 'admin']);
      if (!firmId) return { error: err(403, 'advisor or reviewer profile required') };
      const docId = typeof body.document_id === 'string' ? body.document_id : null;
      if (!docId) return { error: err(400, 'document_id required') };
      if (!(await visibleUnderRls(ctx, 'documents', docId))) return { error: err(404, 'document not found') };
      return { firmId };
    }
    case 'sellside-engagement': {
      // Staff = advisor or reviewer; resolve the firm from the profile.
      const firmId = await firmFromProfile(ctx, ['advisor', 'reviewer', 'admin']);
      if (!firmId) return { error: err(403, 'advisor or reviewer profile required') };
      const engagementId = typeof body.engagement_id === 'string' ? body.engagement_id : null;
      if (!engagementId) return { error: err(400, 'engagement_id required') };
      if (!(await visibleUnderRls(ctx, 'engagements', engagementId)))
        return { error: err(404, 'engagement not found') };
      return { firmId };
    }
    case 'sellside-item': {
      const firmId = await firmFromProfile(ctx, ['advisor', 'reviewer', 'admin']);
      if (!firmId) return { error: err(403, 'advisor or reviewer profile required') };
      // Resolve the engagement the item belongs to (from the item, never the body),
      // then confirm the caller can see that engagement under RLS.
      const itemId = typeof body.review_item_id === 'string' ? body.review_item_id : null;
      if (!itemId) return { error: err(400, 'review_item_id required') };
      const engagementId =
        (await ctx.service.query(`select engagement_id from review_items where id = $1`, [itemId])).rows[0]
          ?.engagement_id ?? null;
      if (!engagementId) return { error: err(404, 'review item not found') };
      if (!(await visibleUnderRls(ctx, 'engagements', engagementId)))
        return { error: err(404, 'engagement not found') };
      return { firmId };
    }
    case 'ledger-connect': {
      // Company-scoped connect/disconnect: the company id in the body must be
      // visible to the caller under RLS.
      const companyId = typeof body.company_id === 'string' ? body.company_id : null;
      if (!companyId) return { error: err(400, 'company_id required') };
      if (!(await visibleUnderRls(ctx, 'companies', companyId))) return { error: err(404, 'company not found') };
      return { firmId: null };
    }
    case 'ledger-complete': {
      // complete() carries only the opaque state, so read the company from the
      // pending row, then confirm the caller can see it under RLS. An unknown
      // state passes through here so the handler can return the proper "invalid or
      // expired" error rather than a misleading 404.
      const companyId =
        (await ctx.service.query(`select company_id from ledger_oauth_states where state = $1`, [body.state]))
          .rows[0]?.company_id ?? null;
      if (companyId && !(await visibleUnderRls(ctx, 'companies', companyId)))
        return { error: err(404, 'company not found') };
      return { firmId: null };
    }
    case 'engagement': {
      const engagementId = typeof body.engagement_id === 'string' ? body.engagement_id : null;
      if (!engagementId) return { error: err(400, 'engagement_id required') };
      if (!(await visibleUnderRls(ctx, 'engagements', engagementId)))
        return { error: err(404, 'engagement not found') };
      return { firmId: null };
    }
    case 'manage-engagement': {
      // Firm staff (advisor/admin) managing an engagement's participants: resolve
      // the caller's own firm (rejecting owners/reviewers/collaborators), then
      // confirm the target engagement is visible under RLS. Used by the
      // collaborator invite/revoke endpoints.
      const firmId = await firmFromProfile(ctx, ['advisor', 'admin']);
      if (!firmId) return { error: err(403, 'advisor profile required') };
      const engId = typeof body.engagement_id === 'string' ? body.engagement_id : null;
      if (!engId) return { error: err(400, 'engagement_id required') };
      if (!(await visibleUnderRls(ctx, 'engagements', engId))) return { error: err(404, 'engagement not found') };
      return { firmId };
    }
    case 'assessment': {
      const ids = [body.assessment_id, body.prior_assessment_id, body.current_assessment_id].filter(
        (v): v is string => typeof v === 'string',
      );
      const visible = await ctx.asUser(async (c) => {
        const r = await c.query(`select id from assessments where id = any($1)`, [ids]);
        return ids.length > 0 && r.rowCount === ids.length;
      });
      if (!visible) return { error: err(404, 'assessment not found') };
      return { firmId: null };
    }
    case 'platform-admin': {
      // Cross-tenant governance (methodology publishing), NOT a firm-scoped role.
      // The gate is the caller's Clerk id against the platform-superadmin
      // allowlist — never a profile role, never a firm — so no firm admin can
      // reach it. Resolves no firm (global methodology).
      if (!isPlatformSuperadmin(ctx.userId)) return { error: err(403, 'platform superadmin required') };
      return { firmId: null };
    }
    default: {
      // AuthScope is a closed union; every scope has a case above. This makes an
      // unhandled scope a compile error the day one is added without a gate.
      const _exhaustive: never = scope;
      return { error: err(500, `unhandled auth scope '${_exhaustive as string}'`) };
    }
  }
}

// The single entry point a host mounts. Looks up the function in the registry,
// authorizes it through RLS by its declared scope, applies the billing gate, then
// dispatches to its handler with the service-role client. Business errors surface
// as 400s, matching the dev emulator's prior behavior.
export async function handleFunctionCall(
  name: string,
  body: Record<string, unknown>,
  ctx: FunctionContext,
): Promise<FunctionResult> {
  const spec: FunctionSpec | undefined = REGISTRY[name];
  if (!spec) return err(404, `unknown function '${name}'`);

  const authz = await authorize(spec.scope, body, ctx);
  if ('error' in authz) return authz.error;

  // Billing gate: refuse gated actions for an unentitled firm. No-op unless
  // BILLING_ENFORCED is on (so the current app + a comped beta are unaffected).
  const gateMsg = await entitlementGate(name, authz.firmId, ctx.service);
  if (gateMsg) return err(402, gateMsg);

  try {
    return await spec.handler({
      service: ctx.service,
      body,
      firmId: authz.firmId,
      userId: ctx.userId,
      asUser: ctx.asUser,
    });
  } catch (e) {
    return err(400, (e as Error).message);
  }
}
