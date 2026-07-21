// Data + pure helpers for the internal Platform Console
// (src/pages/PlatformConsolePage.tsx) — one superadmin surface that renders
// the whole metrics rail (docs/38, docs/40).
//
// COMPLETELY INDEPENDENT of the tenant product surfaces (this session's brief):
// the console reads ONLY the superadmin-gated, service-role, READ-ONLY
// `GET /internal/metrics` rail (server/http.ts). It uses no tenant query hooks
// (src/lib/queries.ts), writes nothing, and never touches scoring or firm data —
// it renders the `analytics`-schema rollups the rail already computes. See
// CLAUDE.md §1-2 (read-only, AI never involved) and §5 / docs/38 §0 (cross-firm
// isolation lives behind the service-role path, never a loosened tenant policy).
//
// This module is dependency-free — types + pure helpers only, unit-tested in
// tests/platform-console.test.ts (per templates/pure-module.ts). The one piece
// that needs browser transport (the fetch against the rail) lives in the page
// (src/pages/PlatformConsolePage.tsx), so importing these helpers never pulls in
// browser globals.

type Row = Record<string, unknown>;

// The shape `GET /internal/metrics` returns: the four-domain platform snapshot
// (server/platform-metrics.ts) spread with the two moat rails — the verified
// financial corpus (server/financial-corpus.ts, `corpus`) and the calibration-
// corpus KPIs (server/moat-metrics.ts, `moats`). Kept loose (Record-based) on
// purpose: the rail's views own the exact columns; the console renders whatever
// they send, humanized — so a new view column flows through with no UI change.
export interface PlatformSnapshot {
  generated_at: string;
  totals: Record<string, number>;
  product: { funnel: Record<string, number>; usage_30d: Row[] };
  business: { firms: Row[]; subscriptions: Row[] };
  security: { access_30d: Row[] };
  ops: { webhooks: Row[]; ai_cost_30d: Row[]; note: string };
  corpus: {
    verified_coverage: Row[];
    verified_metrics: Row[];
    own_book_multiples: Row[];
    ledger_coverage: Row[];
    note: string;
  };
  moats: { corpus: Record<string, number>; corpus_monthly: Row[] };
}

// A fetch failure that carries the HTTP status, so the page can tell "you are
// signed in but not a platform superadmin" (403) apart from a real outage and
// render the right card instead of a generic error.
export class PlatformFetchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PlatformFetchError';
    this.status = status;
  }
}

// ---- Pure helpers (unit-tested in tests/platform-console.test.ts) ----

// Postgres returns count()/numeric as strings; coerce anything to a finite
// number (non-numeric → 0) so tiles and sorts behave.
export function toNumber(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

// One firm's engagement health, for the account / churn book — the BD readout
// docs/38 §3C names ("a firm's active-engagement count dropping to zero" is the
// churn signal). Derived only from what the rail exposes (active engagements +
// days since last activity), never a tenant read.
export type FirmActivity = 'active' | 'idle' | 'dormant';

export function firmActivityStatus(
  activeEngagements: number,
  lastActivityDays: number | null,
): FirmActivity {
  // No live engagement, or silent for two months → dormant. 30–60 days quiet →
  // idle (worth a nudge). Otherwise active.
  if (activeEngagements <= 0) return 'dormant';
  if (lastActivityDays === null || lastActivityDays > 60) return 'dormant';
  if (lastActivityDays > 30) return 'idle';
  return 'active';
}

// The activation funnel as ordered steps, each with its conversion off the FIRST
// step, so "12 of 40 engagements produced a scored assessment" reads at a glance.
export interface FunnelStep {
  key: string;
  value: number;
  pctOfStart: number | null;
}
const FUNNEL_ORDER = [
  'engagements',
  'assessments_started',
  'assessments_completed',
  'assessments_scored',
];
export function funnelSteps(funnel: Record<string, number>): FunnelStep[] {
  const start = funnel[FUNNEL_ORDER[0]] ?? 0;
  return FUNNEL_ORDER.filter((k) => k in funnel).map((k) => ({
    key: k,
    value: funnel[k] ?? 0,
    pctOfStart: start > 0 ? Math.round(((funnel[k] ?? 0) / start) * 100) : null,
  }));
}

// Sum a numeric column across rows (e.g. total AI spend over the window).
export function sumColumn(rows: Row[], key: string): number {
  return rows.reduce((acc, r) => acc + toNumber(r[key]), 0);
}

// Roll a day-grained usage series up to per-event totals over the window,
// biggest first — the "what are advisors actually doing" list. `firms` is a
// lower-bound (max distinct-firms on any one day), since distinct counts can't
// be summed across days without double-counting.
export function topEvents(
  rows: Row[],
  limit = 8,
): { label: string; events: number; firms: number }[] {
  const byName = new Map<string, { events: number; firms: number }>();
  for (const r of rows) {
    const label = String(r.event_name ?? r.event_type ?? 'unknown');
    const prev = byName.get(label) ?? { events: 0, firms: 0 };
    prev.events += toNumber(r.events);
    prev.firms = Math.max(prev.firms, toNumber(r.firms));
    byName.set(label, prev);
  }
  return [...byName.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.events - a.events)
    .slice(0, limit);
}
