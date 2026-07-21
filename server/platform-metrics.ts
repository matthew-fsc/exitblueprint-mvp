// Platform monitoring rails (docs/38) — assemble the ExitBlueprint team's
// cross-tenant, four-domain platform snapshot from the service-role-only
// `analytics` schema (supabase/migrations/..._platform_analytics.sql).
//
// Read-only (CLAUDE.md §1-2): every query is a SELECT over a rollup view; nothing
// here writes a score, mutates an assessment, or touches client data. This runs
// ONLY on the service-role connection behind the superadmin-gated
// GET /internal/metrics route (server/http.ts) — never on a tenant JWT path.
import type pg from 'pg';

// Either a pooled client or the Pool itself — both expose `.query`. The route
// passes the service-role Pool directly (no per-request transaction needed for a
// read-only cross-tenant snapshot); the test passes a fake client.
type Queryable = Pick<pg.ClientBase, 'query'> | Pick<pg.Pool, 'query'>;

export interface PlatformMetrics {
  generated_at: string;
  // Grand totals across the platform (business overview).
  totals: Record<string, number>;
  // Product & usage: the activation funnel + recent usage-event rollup.
  product: {
    funnel: Record<string, number>;
    usage_30d: Record<string, unknown>[];
  };
  // Business & billing: per-firm overview + subscription unit counts.
  business: {
    firms: Record<string, unknown>[];
    subscriptions: Record<string, unknown>[];
  };
  // Security & compliance: access-log rollup.
  security: {
    access_30d: Record<string, unknown>[];
  };
  // Infra & ops: webhook health + AI cost/latency. Uptime/latency/error rates
  // come from the hosting services (Render logs, Sentry, Vercel) — see `note`.
  ops: {
    webhooks: Record<string, unknown>[];
    ai_cost_30d: Record<string, unknown>[];
    note: string;
  };
}

// Postgres returns count()/numeric as strings; coerce a one-row scalar object to
// numbers so the JSON is charts-ready. Row arrays pass through untouched.
function numify(row: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row ?? {})) out[k] = Number(v);
  return out;
}

const OPS_NOTE =
  'Uptime, request latency and error rates come from the hosting services ' +
  '(Render access logs, Sentry, Vercel Analytics) — see docs/32 and docs/38. ' +
  'The in-DB ops signals here are webhook health and AI cost/latency.';

export async function platformMetrics(db: Queryable): Promise<PlatformMetrics> {
  const totals = (await db.query('select * from analytics.platform_totals')).rows[0];
  const funnel = (await db.query('select * from analytics.assessment_funnel')).rows[0];

  const usage = (
    await db.query(
      `select day, event_type, event_name, events, firms, sessions
         from analytics.usage_daily
        where day >= current_date - interval '30 days'
        order by day desc, events desc`,
    )
  ).rows;

  const firms = (
    await db.query('select * from analytics.firm_overview order by created_at desc')
  ).rows;
  const subscriptions = (
    await db.query('select * from analytics.subscription_summary order by plan_code, status')
  ).rows;

  const access = (
    await db.query(
      `select day, action, resource_type, events, firms
         from analytics.access_log_daily
        where day >= current_date - interval '30 days'
        order by day desc`,
    )
  ).rows;

  const webhooks = (
    await db.query('select * from analytics.ops_webhook_health order by events desc')
  ).rows;
  const aiCost = (
    await db.query(
      `select day, model, calls, input_tokens, output_tokens, cost_usd, avg_latency_ms
         from analytics.ai_cost_daily
        where day >= current_date - interval '30 days'
        order by day desc`,
    )
  ).rows;

  return {
    generated_at: new Date().toISOString(),
    totals: numify(totals),
    product: { funnel: numify(funnel), usage_30d: usage },
    business: { firms, subscriptions },
    security: { access_30d: access },
    ops: { webhooks, ai_cost_30d: aiCost, note: OPS_NOTE },
  };
}
