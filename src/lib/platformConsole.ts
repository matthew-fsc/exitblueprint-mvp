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
  // Company operating plan (docs/40 §4b) — activation funnel, revenue plan, raw
  // unit-economics components, and the engagement-health delivery signal.
  operating: {
    activation: Record<string, number>;
    revenue: Record<string, number>;
    unit_economics: Record<string, number>;
    engagement_health: Record<string, number>;
  };
  corpus: {
    verified_coverage: Row[];
    verified_metrics: Row[];
    own_book_multiples: Row[];
    own_book_valuation_multiples: Row[];
    ledger_coverage: Row[];
    note: string;
  };
  moats: { corpus: Record<string, number>; corpus_monthly: Row[] };
  // The versioned DRS-band calibration artifact (docs/09 moat 1, the FICO moat):
  // for each score band, how the platform's predictions have tracked reality. Bands
  // are de-identified aggregates; calibration_version is null until first computed.
  calibration: {
    calibration_version: number | null;
    computed_at: string | null;
    band_width: number | null;
    total_outcomes: number | null;
    total_closed: number | null;
    contributing_firms: number | null;
    bands: Row[];
    note: string;
  };
}

// Split the calibration bands into a score group ('drs' | 'ori'), ascending by
// band_low — so the console renders DRS bands and ORI bands as separate tables
// (rule #3a, never mixed). Pure; unit-tested in tests/platform-console.test.ts.
export function calibrationBands(bands: Row[], group: 'drs' | 'ori'): Row[] {
  return bands
    .filter((b) => b.group_key === group)
    .sort((a, b) => toNumber(a.band_low) - toNumber(b.band_low));
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
// Turn a one-row funnel rollup into ordered steps, each with its conversion off
// the FIRST present step. Shared by the assessment funnel and the firm-level
// activation funnel — pass the ordered keys the caller cares about.
export function orderedFunnel(funnel: Record<string, number>, order: string[]): FunnelStep[] {
  const present = order.filter((k) => k in funnel);
  const start = present.length ? (funnel[present[0]] ?? 0) : 0;
  return present.map((k) => ({
    key: k,
    value: funnel[k] ?? 0,
    pctOfStart: start > 0 ? Math.round(((funnel[k] ?? 0) / start) * 100) : null,
  }));
}

const FUNNEL_ORDER = [
  'engagements',
  'assessments_started',
  'assessments_completed',
  'assessments_scored',
];
export function funnelSteps(funnel: Record<string, number>): FunnelStep[] {
  return orderedFunnel(funnel, FUNNEL_ORDER);
}

// The go-to-market activation funnel (docs/40 §4b), FIRM-level: firm created →
// an advisor did something → first assessment → first deliverable. Leading
// indicator of where firms fall out of the activation path.
const ACTIVATION_ORDER = [
  'firms_created',
  'firms_activated',
  'firms_first_assessment',
  'firms_first_deliverable',
];
export function activationSteps(activation: Record<string, number>): FunnelStep[] {
  return orderedFunnel(activation, ACTIVATION_ORDER);
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

// ---- Unit economics / COGS (docs/40 §4b) ----

// Per-unit COGS derived from the raw components the analytics.unit_economics view
// exposes. AI spend is the dominant variable cost; dividing it by the value units
// (active firms, completed assessments) gives the unit economics the operating
// plan tracks. Kept as a PURE derivation (null-safe division) so the ratios are
// unit-tested here rather than computed in SQL. A zero denominator yields null (a
// ratio that doesn't exist yet), never Infinity/NaN.
export interface UnitEconomics {
  ai_cost_30d: number;
  ai_cost_total: number;
  cost_per_active_firm_30d: number | null;
  cost_per_completed_assessment: number | null;
  cost_per_engagement: number | null;
}
function ratio(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return Math.round((numerator / denominator) * 100) / 100;
}
export function unitEconomics(raw: Record<string, number>): UnitEconomics {
  const cost30d = toNumber(raw.ai_cost_30d);
  const costTotal = toNumber(raw.ai_cost_total);
  return {
    ai_cost_30d: cost30d,
    ai_cost_total: costTotal,
    cost_per_active_firm_30d: ratio(cost30d, toNumber(raw.active_firms)),
    cost_per_completed_assessment: ratio(costTotal, toNumber(raw.completed_assessments)),
    cost_per_engagement: ratio(costTotal, toNumber(raw.engagements)),
  };
}

// ---- Churn-risk book (docs/40 §4b) ----

// Roll the per-firm overview rows up into the churn book's headline counts, using
// the SAME firmActivityStatus classification the firm table renders, so the tiles
// and the table can never disagree. `atRiskPaying` is the number that matters: a
// paying/comped firm that has gone idle or dormant — money at risk of churning.
export interface ChurnBook {
  active: number;
  idle: number;
  dormant: number;
  atRiskPaying: number;
}
const PAYING_STATUSES = new Set(['active', 'trialing', 'past_due']);
export function churnBook(firms: Row[]): ChurnBook {
  const book: ChurnBook = { active: 0, idle: 0, dormant: 0, atRiskPaying: 0 };
  for (const f of firms) {
    const status = firmActivityStatus(
      toNumber(f.active_engagements),
      daysSinceRow(f.last_activity_at),
    );
    book[status] += 1;
    const paying =
      f.comp === true || PAYING_STATUSES.has(String(f.subscription_status ?? ''));
    if (paying && status !== 'active') book.atRiskPaying += 1;
  }
  return book;
}

// Whole days since an ISO timestamp (or null). Local to this dependency-free
// module so churnBook stays testable without importing the browser format lib.
function daysSinceRow(v: unknown): number | null {
  if (v == null) return null;
  const t = new Date(String(v)).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
