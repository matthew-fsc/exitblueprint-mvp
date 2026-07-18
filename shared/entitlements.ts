// Entitlement resolution — pure, deterministic, unit-tested (mirrors the
// buildAlignment / rankComparables pattern). Given a firm's cached subscription
// row and its plan, decide whether the firm may use gated features, and expose
// the plan's limits + capability set. No I/O, no Stripe calls — the server layer
// (server/entitlements.ts) reads the rows and the Stripe webhook keeps them
// fresh; this module only interprets them.
//
// Beta: a firm with comp = true is fully entitled regardless of Stripe status,
// which is how a comped beta test group gets access before any billing is wired.

export interface PlanRow {
  code: string;
  name: string;
  seat_limit: number | null; // null = unlimited
  engagement_limit: number | null; // null = unlimited
  features: string[]; // capability keys
}

export interface SubscriptionRow {
  plan_code: string | null;
  status: string; // trialing | active | past_due | canceled | incomplete
  seats: number;
  comp: boolean;
}

export type EntitlementReason =
  | 'comp' // beta / internal grant
  | 'active' // paid, in good standing
  | 'trialing' // in trial
  | 'past_due_grace' // payment failed, still within grace (read/write allowed)
  | 'none' // no subscription row at all
  | 'inactive'; // canceled / incomplete

export interface Entitlement {
  entitled: boolean;
  reason: EntitlementReason;
  planCode: string | null;
  planName: string | null;
  seatLimit: number | null; // null = unlimited
  engagementLimit: number | null; // null = unlimited
  features: string[];
}

// Statuses that still grant access. `past_due` stays entitled here (the grace
// window); the eventual past_due -> read-only cutover is a time-based decision
// layered on top in the Stripe dunning slice, not this pure interpreter.
const ENTITLED_STATUSES: Record<string, EntitlementReason> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due_grace',
};

export function resolveEntitlement(
  sub: SubscriptionRow | null,
  plan: PlanRow | null,
): Entitlement {
  const base = {
    planCode: plan?.code ?? sub?.plan_code ?? null,
    planName: plan?.name ?? null,
    seatLimit: plan?.seat_limit ?? null,
    engagementLimit: plan?.engagement_limit ?? null,
    features: plan?.features ?? [],
  };

  if (!sub) return { entitled: false, reason: 'none', ...base };

  // Comp overrides Stripe status entirely (beta / internal).
  if (sub.comp) return { entitled: true, reason: 'comp', ...base };

  const reason = ENTITLED_STATUSES[sub.status];
  if (reason) return { entitled: true, reason, ...base };

  return { entitled: false, reason: 'inactive', ...base };
}

// Does the entitlement include a given capability? A comped/entitled firm with no
// plan attached is treated as having no feature-level restriction (beta = full),
// so an empty feature set on an entitled firm allows everything.
export function hasFeature(ent: Entitlement, feature: string): boolean {
  if (!ent.entitled) return false;
  if (ent.features.length === 0) return true; // no plan restriction (e.g. bare comp)
  return ent.features.includes(feature);
}

// Seat / engagement limit checks (pure). null limit = unlimited. Wired into the
// invite/create-engagement paths when billing is enforced (Stripe slice).
export function withinLimit(current: number, limit: number | null): boolean {
  return limit === null || current < limit;
}
