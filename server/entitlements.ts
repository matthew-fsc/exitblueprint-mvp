// Server-side entitlement resolution + the feature gate applied in the function
// router's authorize path (server/functions.ts). Reads the cached billing rows
// (service role — the webhook keeps them fresh) and interprets them with the
// pure resolver in shared/entitlements.ts.
//
// Enforcement is OFF by default (BILLING_ENFORCED unset/!= 'true'), so the running
// app and a comped beta are unaffected: the gate only refuses calls once billing
// is turned on for GA. Even then, comped firms pass (resolveEntitlement).
import type pg from 'pg';
import { resolveEntitlement, type Entitlement } from '../shared/entitlements';

export type { Entitlement };

// The paid actions (Combo C, docs/24 §5.3). Viewing existing data is never gated —
// a firm never loses read access to its own records. Only actions that produce new
// work / deliverables are here.
export const GATED_FNS = new Set<string>([
  'create-engagement',
  'score-assessment',
  'compute-valuation',
  'generate-roadmap',
  'generate-document',
  'render-owner-pdf',
  'render-delta-pdf',
  'render-cim-pdf',
  'invite-owner',
]);

export function billingEnforced(): boolean {
  return process.env.BILLING_ENFORCED === 'true';
}

// Read a firm's entitlement from the cached rows. Runs as the caller-agnostic
// service client (billing rows are service-role only); the firmId is always
// resolved from the caller's own profile upstream, never from the request body.
export async function getFirmEntitlement(
  db: pg.ClientBase,
  firmId: string,
): Promise<Entitlement> {
  const sub = (
    await db.query(
      `select plan_code, status, seats, comp from firm_subscriptions where firm_id = $1`,
      [firmId],
    )
  ).rows[0] ?? null;
  const plan = sub?.plan_code
    ? (
        await db.query(
          `select code, name, seat_limit, engagement_limit, features from plans where code = $1`,
          [sub.plan_code],
        )
      ).rows[0] ?? null
    : null;
  return resolveEntitlement(
    sub && {
      plan_code: sub.plan_code,
      status: sub.status,
      seats: sub.seats,
      comp: sub.comp,
    },
    plan && {
      code: plan.code,
      name: plan.name,
      seat_limit: plan.seat_limit,
      engagement_limit: plan.engagement_limit,
      features: Array.isArray(plan.features) ? plan.features : [],
    },
  );
}

// Gate result: null = allowed; a string message = refuse (402). Only ever refuses
// when billing is enforced AND the action is gated AND the firm is not entitled.
export async function entitlementGate(
  name: string,
  firmId: string | null,
  db: pg.ClientBase,
): Promise<string | null> {
  if (!billingEnforced() || !GATED_FNS.has(name) || !firmId) return null;
  const ent = await getFirmEntitlement(db, firmId);
  if (ent.entitled) return null;
  return 'This action requires an active subscription. Please update your plan in Settings → Billing.';
}
