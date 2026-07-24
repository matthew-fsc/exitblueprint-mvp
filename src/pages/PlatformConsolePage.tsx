// Platform Console — ONE internal superadmin surface that renders the whole
// metrics rail (docs/38 "one rail, many readouts"; docs/40 §4b "the company runs
// on its own metrics rail"). It reads the superadmin-gated, service-role,
// read-only GET /internal/metrics endpoint and lays out every readout — platform
// totals, the business-development funnel + account/churn book, product usage,
// the moat/business-plan KPIs, ops & AI cost, and the security access log — on a
// single page.
//
// INDEPENDENT of the tenant product (this session's brief): its own route and
// its own minimal chrome (NOT the advisor Shell/AppBar, no firm branding), its
// own data path (src/lib/platformConsole.ts, not the tenant query hooks), and
// read-only throughout. The server enforces the real gate (PLATFORM_SUPERADMIN_IDS);
// a signed-in non-superadmin just gets the access card below.
//
// Design system: docs/26 — no raw snake_case, raw integers, or hand-rolled
// tables; every key is humanized and every number goes through src/lib/format.
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatBlock,
  StatRow,
  type Column,
} from '../components/ui';
import { daysSince, fmtCurrency, fmtDate, fmtScore, formatFieldValue, humanizeKey } from '../lib/format';
import { PromptRegistryCard } from '../components/PromptRegistryCard';
import { functionsBaseUrl, getAccessToken } from '../lib/supabase';
import {
  activationSteps,
  calibrationBands,
  churnBook,
  firmActivityStatus,
  funnelSteps,
  PlatformFetchError,
  toNumber,
  topEvents,
  unitEconomics,
  type FirmActivity,
  type PlatformSnapshot,
} from '../lib/platformConsole';

type Row = Record<string, unknown>;

// GET the rail directly. It is a platform-ops route beside /health and /ready —
// NOT a /functions/v1 tenant function — so this issues its own request rather
// than going through invokeFunction. Auth is the caller's session JWT; the
// server enforces the PLATFORM_SUPERADMIN_IDS allowlist. (Cross-origin in prod:
// GET is a CORS-safelisted method, so the existing preflight allows it.) This is
// the ONLY browser-coupled piece; the helpers it uses stay dependency-free.
async function fetchPlatformSnapshot(): Promise<PlatformSnapshot> {
  const token = await getAccessToken();
  const res = await fetch(`${functionsBaseUrl}/internal/metrics`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new PlatformFetchError(res.status, detail?.message ?? `request failed (${res.status})`);
  }
  return res.json() as Promise<PlatformSnapshot>;
}

// ---- small presentational helpers (kept local; this surface is standalone) ----

const ACTIVITY_CHIP: Record<FirmActivity, { cls: string; label: string; rank: number }> = {
  active: { cls: 'status-good', label: 'Active', rank: 2 },
  idle: { cls: 'status-warning', label: 'Idle', rank: 1 },
  dormant: { cls: 'status-serious', label: 'Dormant', rank: 0 },
};

function subscriptionChipClass(status: string): string {
  switch (status) {
    case 'active':
      return 'status-good';
    case 'trialing':
      return 'status-ok';
    case 'past_due':
      return 'status-serious';
    case 'canceled':
      return 'status-critical';
    default:
      return 'status-neutral';
  }
}

// A generic, robust table for rail rows whose columns the views own: infer the
// columns from the row shape, humanize headers, format cells (dates as dates,
// everything else through formatFieldValue — so no raw snake_case or bare
// integers reach the screen), and make numeric columns sortable.
const DATE_KEY = /(_at|_date|_end|^day$|^month$)/;
function inferColumns(rows: Row[]): Column<Row>[] {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  return keys.map((key) => {
    const isDate = DATE_KEY.test(key);
    const sample = rows.find((r) => r[key] != null)?.[key];
    const numeric =
      !isDate &&
      (typeof sample === 'number' ||
        (typeof sample === 'string' && sample.trim() !== '' && !Number.isNaN(Number(sample))));
    return {
      key,
      header: humanizeKey(key),
      numeric,
      render: (r: Row) => (isDate ? fmtDate(r[key] as string) : formatFieldValue(key, r[key])),
      sortValue: (r: Row) => (numeric ? toNumber(r[key]) : String(r[key] ?? '')),
    };
  });
}

function AutoTable({
  rows,
  initialSort,
  emptyLabel = 'No data yet',
}: {
  rows: Row[];
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  emptyLabel?: string;
}) {
  if (!rows.length) return <EmptyState icon="empty" title={emptyLabel} />;
  return (
    <DataTable
      columns={inferColumns(rows)}
      rows={rows}
      keyFor={(r) => JSON.stringify(r)}
      initialSort={initialSort}
    />
  );
}

// The moat / business-plan KPIs (docs/40 §4a "the moats ARE the business plan"),
// each with the right unit. Absent keys (empty corpus) are skipped.
const MOAT_TILES: { key: string; label: string; fmt: (n: number) => string }[] = [
  { key: 'paired_outcomes', label: 'Paired outcomes', fmt: (n) => String(Math.round(n)) },
  { key: 'closed_deals', label: 'Closed deals', fmt: (n) => String(Math.round(n)) },
  { key: 'within_range_pct', label: 'Within-range hit rate', fmt: (n) => `${fmtScore(n)}%` },
  { key: 'avg_ev_variance_pct', label: 'Avg EV variance', fmt: (n) => `${fmtScore(n)}%` },
  { key: 'avg_final_multiple', label: 'Avg final multiple', fmt: (n) => `${fmtScore(n)}×` },
  { key: 'retrade_rate_pct', label: 'Retrade rate', fmt: (n) => `${fmtScore(n)}%` },
  { key: 'avg_days_on_market', label: 'Avg days on market', fmt: (n) => `${Math.round(n)} days` },
];

// ---- DRS calibration bands (the FICO moat: docs/09 §1) ----

const calPct = (v: unknown) => (v == null ? '—' : `${fmtScore(toNumber(v))}%`);
const calMult = (v: unknown) => (v == null ? '—' : `${fmtScore(toNumber(v))}×`);

// The versioned calibration artifact, one row per score band, rendered with the
// right unit per column (multiple ×, rates %, days) and a low-confidence chip for
// thin cells. `groupHeader` names the band column ("DRS band" / "ORI band").
function CalibrationBandsTable({ rows, groupHeader }: { rows: Row[]; groupHeader: string }) {
  if (!rows.length) return <EmptyState icon="empty" title="No bands in this group yet" />;
  const columns: Column<Row>[] = [
    {
      key: 'band_label',
      header: groupHeader,
      render: (r) => (
        <span>
          <strong>{String(r.band_label ?? '—')}</strong>
          {r.low_confidence === true && (
            <span className="status-chip status-neutral" style={{ marginLeft: '0.4rem' }}>
              Low confidence
            </span>
          )}
        </span>
      ),
      sortValue: (r) => toNumber(r.band_low),
    },
    { key: 'sample_n', header: 'Deals', numeric: true, render: (r) => String(toNumber(r.sample_n)), sortValue: (r) => toNumber(r.sample_n) },
    { key: 'close_rate_pct', header: 'Close rate', numeric: true, render: (r) => calPct(r.close_rate_pct), sortValue: (r) => toNumber(r.close_rate_pct) },
    {
      key: 'median_multiple',
      header: 'Multiple (P25–P75)',
      numeric: true,
      render: (r) =>
        r.median_multiple == null ? (
          '—'
        ) : (
          <span>
            {calMult(r.median_multiple)}
            <span className="muted text-sm" style={{ display: 'block' }}>
              {calMult(r.p25_multiple)}–{calMult(r.p75_multiple)}
            </span>
          </span>
        ),
      sortValue: (r) => toNumber(r.median_multiple),
    },
    {
      key: 'median_days_to_close',
      header: 'Time to close',
      numeric: true,
      render: (r) => (r.median_days_to_close == null ? '—' : `${toNumber(r.median_days_to_close)} days`),
      sortValue: (r) => toNumber(r.median_days_to_close),
    },
    { key: 'within_range_hit_rate_pct', header: 'Within range', numeric: true, render: (r) => calPct(r.within_range_hit_rate_pct), sortValue: (r) => toNumber(r.within_range_hit_rate_pct) },
    { key: 'ev_variance_pct', header: 'EV variance', numeric: true, render: (r) => calPct(r.ev_variance_pct), sortValue: (r) => toNumber(r.ev_variance_pct) },
    { key: 'retrade_rate_pct', header: 'Retrade rate', numeric: true, render: (r) => calPct(r.retrade_rate_pct), sortValue: (r) => toNumber(r.retrade_rate_pct) },
    { key: 'contributing_firms', header: 'Firms', numeric: true, render: (r) => String(toNumber(r.contributing_firms)), sortValue: (r) => toNumber(r.contributing_firms) },
  ];
  return <DataTable columns={columns} rows={rows} keyFor={(r) => String(r.band_label)} initialSort={{ key: 'band_label', dir: 'desc' }} />;
}

// ---- Deliverable quality — ExitBlueprint Bench (docs/sellside-ai/02) ----

// Score fractions [0,1] rendered as a whole-number percent. Pass thresholds are
// per-axis (docs/sellside-ai/02): answer must be ≥ 90%, source must be a perfect
// 100% (every claim traceable). A failing cell gets the subtle warning tone, and
// the row carries a Pass/Review chip — neutral when both axes pass.
const benchPct = (v: unknown) => `${Math.round(toNumber(v) * 100)}%`;
const ANSWER_PASS = 0.9;

function BenchTable({ rows }: { rows: Row[] }) {
  if (!rows.length)
    return (
      <EmptyState
        icon="empty"
        title="No bench results yet. Run the Bench (run-bench) to populate this scorecard."
      />
    );
  const columns: Column<Row>[] = [
    {
      key: 'doc_type',
      header: 'Doc type',
      render: (r) => (
        <span>
          <strong>{humanizeKey(String(r.doc_type ?? '—'))}</strong>
          {r.case_name != null && (
            <span className="muted text-sm" style={{ display: 'block' }}>
              {String(r.case_name)}
            </span>
          )}
        </span>
      ),
      sortValue: (r) => String(r.doc_type ?? ''),
    },
    {
      key: 'prompt_version',
      header: 'Prompt version',
      render: (r) => String(r.prompt_version ?? '—'),
      sortValue: (r) => String(r.prompt_version ?? ''),
    },
    {
      key: 'tier',
      header: 'Tier',
      render: (r) => (r.tier ? humanizeKey(String(r.tier)) : '—'),
      sortValue: (r) => String(r.tier ?? ''),
    },
    {
      key: 'answer_score',
      header: 'Answer',
      numeric: true,
      render: (r) => {
        const pass = toNumber(r.answer_score) >= ANSWER_PASS;
        return <span className={pass ? undefined : 'cal-miss'}>{benchPct(r.answer_score)}</span>;
      },
      sortValue: (r) => toNumber(r.answer_score),
    },
    {
      key: 'source_score',
      header: 'Source',
      numeric: true,
      render: (r) => {
        const pass = toNumber(r.source_score) >= 1;
        return <span className={pass ? undefined : 'cal-miss'}>{benchPct(r.source_score)}</span>;
      },
      sortValue: (r) => toNumber(r.source_score),
    },
    {
      key: 'result',
      header: 'Result',
      render: (r) => {
        const pass = toNumber(r.answer_score) >= ANSWER_PASS && toNumber(r.source_score) >= 1;
        return (
          <span className={`status-chip ${pass ? 'status-neutral' : 'status-warning'}`}>
            {pass ? 'Pass' : 'Review'}
          </span>
        );
      },
      sortValue: (r) =>
        toNumber(r.answer_score) >= ANSWER_PASS && toNumber(r.source_score) >= 1 ? 1 : 0,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      keyFor={(r) => JSON.stringify(r)}
      initialSort={{ key: 'result', dir: 'asc' }}
    />
  );
}

// ---- the firm account / churn book (the BD readout) ----

function FirmBook({ firms }: { firms: Row[] }) {
  if (!firms.length) return <EmptyState icon="empty" title="No firms yet" />;

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Firm',
      render: (r) => <span style={{ fontWeight: 600 }}>{String(r.name ?? '—')}</span>,
      sortValue: (r) => String(r.name ?? ''),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const status = firmActivityStatus(
          toNumber(r.active_engagements),
          daysSince(r.last_activity_at as string | null),
        );
        const chip = ACTIVITY_CHIP[status];
        return <span className={`status-chip ${chip.cls}`}>{chip.label}</span>;
      },
      sortValue: (r) =>
        ACTIVITY_CHIP[
          firmActivityStatus(
            toNumber(r.active_engagements),
            daysSince(r.last_activity_at as string | null),
          )
        ].rank,
    },
    {
      key: 'plan_code',
      header: 'Plan',
      render: (r) => (r.plan_code ? humanizeKey(String(r.plan_code)) : '—'),
      sortValue: (r) => String(r.plan_code ?? ''),
    },
    {
      key: 'subscription_status',
      header: 'Subscription',
      render: (r) =>
        r.subscription_status ? (
          <span className={`status-chip ${subscriptionChipClass(String(r.subscription_status))}`}>
            {humanizeKey(String(r.subscription_status))}
          </span>
        ) : (
          '—'
        ),
      sortValue: (r) => String(r.subscription_status ?? ''),
    },
    {
      key: 'seats',
      header: 'Seats',
      numeric: true,
      render: (r) => (r.seats == null ? '—' : String(toNumber(r.seats))),
      sortValue: (r) => toNumber(r.seats),
    },
    {
      key: 'engagements',
      header: 'Engagements',
      numeric: true,
      render: (r) => `${toNumber(r.active_engagements)} / ${toNumber(r.engagements)}`,
      sortValue: (r) => toNumber(r.active_engagements),
    },
    {
      key: 'completed_assessments',
      header: 'Assessments',
      numeric: true,
      render: (r) => String(toNumber(r.completed_assessments)),
      sortValue: (r) => toNumber(r.completed_assessments),
    },
    {
      key: 'last_activity_at',
      header: 'Last activity',
      numeric: true,
      render: (r) => {
        const d = daysSince(r.last_activity_at as string | null);
        return d === null ? '—' : d === 0 ? 'today' : `${d}d ago`;
      },
      sortValue: (r) => daysSince(r.last_activity_at as string | null) ?? Number.MAX_SAFE_INTEGER,
    },
    {
      key: 'created_at',
      header: 'Joined',
      render: (r) => fmtDate(r.created_at as string),
      sortValue: (r) => String(r.created_at ?? ''),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={firms}
      keyFor={(r) => String(r.firm_id ?? r.name)}
      initialSort={{ key: 'status', dir: 'asc' }}
    />
  );
}

// ---- the page ----

export default function PlatformConsolePage() {
  const q = useQuery({
    queryKey: ['platform', 'console'],
    queryFn: fetchPlatformSnapshot,
    staleTime: 60_000,
    retry: false,
  });

  if (q.isPending) {
    return (
      <div className="stack-lg">
        <PageHeader title="Platform console" subtitle="Internal metrics rail: superadmin only" />
        <LoadingState variant="page" />
      </div>
    );
  }

  if (q.isError) {
    const err = q.error;
    // Signed in, but not on the PLATFORM_SUPERADMIN_IDS allowlist — the endpoint
    // 403s. That is expected for every non-operator; show a plain access card,
    // not a scary error (and no retry — retrying won't grant access).
    if (err instanceof PlatformFetchError && err.status === 403) {
      return (
        <div className="stack-lg">
          <PageHeader title="Platform console" subtitle="Internal metrics rail" />
          <ErrorState
            variant="page"
            title="Superadmin access required"
            message="This is the internal platform operations console. Your account isn’t on the platform-superadmin allowlist, so there’s nothing to show here."
          />
        </div>
      );
    }
    // The rail's `analytics` schema hasn't been migrated on this database yet —
    // the SELECTs 500 with `relation "analytics.…" does not exist`. That is an
    // ops step, not a code fault, so surface the actionable fix instead of the
    // raw Postgres string.
    const msg = err instanceof Error ? err.message : String(err);
    if (/analytics\.[a-z_]+" does not exist|schema "analytics" does not exist/i.test(msg)) {
      return (
        <div className="stack-lg">
          <PageHeader title="Platform console" subtitle="Internal metrics rail" />
          <ErrorState
            variant="page"
            title="Analytics rail not migrated on this database"
            message="The read-only analytics views this console reads don’t exist yet. Apply the pending migrations to this database (npm run db:migrate against its DATABASE_URL, or supabase db push); they add the analytics schema (platform_analytics, financial_corpus, moat_kpis). Then reload."
            onRetry={() => q.refetch()}
            retryLabel="Reload"
          />
        </div>
      );
    }
    return (
      <div className="stack-lg">
        <PageHeader title="Platform console" subtitle="Internal metrics rail" />
        <ErrorState variant="page" error={err} onRetry={() => q.refetch()} />
      </div>
    );
  }

  const s = q.data;
  const funnel = funnelSteps(s.product.funnel);
  const activation = activationSteps(s.operating.activation);
  const econ = unitEconomics(s.operating.unit_economics);
  const churn = churnBook(s.business.firms);
  const rev = s.operating.revenue;
  const health = s.operating.engagement_health;
  const events = topEvents(s.product.usage_30d);
  const moatTiles = MOAT_TILES.filter((t) => t.key in s.moats.corpus);
  const calDrsBands = calibrationBands(s.calibration.bands, 'drs');
  const calOriBands = calibrationBands(s.calibration.bands, 'ori');

  return (
    <div className="stack-lg">
      <PageHeader
        title="Platform console"
        crumbs={[{ label: 'Internal' }, { label: 'Platform' }]}
        subtitle={`Internal metrics rail: one superadmin readout of the whole platform. Snapshot ${fmtDate(
          s.generated_at,
        )}.`}
        actions={
          <button type="button" onClick={() => q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {/* At a glance — platform totals */}
      <SectionCard title="At a glance" subtitle="Grand totals across every firm">
        <StatRow>
          <StatBlock
            label="Firms"
            value={String(toNumber(s.totals.firms))}
            hint={`${toNumber(s.totals.active_firms)} active`}
          />
          <StatBlock label="Companies" value={String(toNumber(s.totals.companies))} />
          <StatBlock
            label="Engagements"
            value={String(toNumber(s.totals.engagements))}
            hint={`${toNumber(s.totals.active_engagements)} active`}
          />
          <StatBlock
            label="Assessments"
            value={String(toNumber(s.totals.assessments))}
            hint={`${toNumber(s.totals.completed_assessments)} completed`}
          />
          <StatBlock label="Documents" value={String(toNumber(s.totals.generated_documents))} />
        </StatRow>
      </SectionCard>

      {/* Activation funnel — the go-to-market leading indicator (docs/40 §4b) */}
      <SectionCard
        title="Activation funnel"
        subtitle="Go-to-market leading indicator: firm created → advisor activated → first assessment → first deliverable"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <StatRow>
            {activation.map((step) => (
              <StatBlock
                key={step.key}
                label={humanizeKey(step.key)}
                value={String(step.value)}
                hint={step.pctOfStart === null ? undefined : `${step.pctOfStart}% of firms`}
              />
            ))}
          </StatRow>
          <div>
            <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
              Assessment funnel: engagements → started → completed → scored
            </p>
            <StatRow>
              {funnel.map((step) => (
                <StatBlock
                  key={step.key}
                  label={humanizeKey(step.key)}
                  value={String(step.value)}
                  hint={step.pctOfStart === null ? undefined : `${step.pctOfStart}% of engagements`}
                />
              ))}
            </StatRow>
          </div>
        </div>
      </SectionCard>

      {/* Revenue plan — subscription units + Stripe state (docs/40 §4b) */}
      <SectionCard
        title="Revenue plan"
        subtitle="Subscription units and Stripe state. Dollar revenue lives in Stripe; this rail carries the unit counts"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <StatRow>
            <StatBlock
              label="Paying firms"
              value={String(toNumber(rev.paying_firms))}
              hint={`${toNumber(rev.subscribed_firms)} subscribed`}
            />
            <StatBlock label="Comped firms" value={String(toNumber(rev.comped_firms))} />
            <StatBlock label="Trialing" value={String(toNumber(rev.trialing_firms))} />
            <StatBlock
              label="Past due"
              value={String(toNumber(rev.past_due_firms))}
              hint={`${toNumber(rev.canceling_firms)} canceling`}
            />
            <StatBlock label="Active seats" value={String(toNumber(rev.active_seats))} />
          </StatRow>
          <div>
            <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
              Subscriptions by plan
            </p>
            <AutoTable
              rows={s.business.subscriptions}
              initialSort={{ key: 'firms', dir: 'desc' }}
              emptyLabel="No subscriptions yet"
            />
          </div>
        </div>
      </SectionCard>

      {/* Unit economics / COGS — AI cost per unit (docs/40 §4b) */}
      <SectionCard
        title="Unit economics"
        subtitle="AI cost is the dominant variable COGS; per-unit ratios show what each firm and assessment costs to serve"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <StatRow>
            <StatBlock label="AI spend (30d)" value={fmtCurrency(econ.ai_cost_30d)} />
            <StatBlock
              label="Cost / active firm (30d)"
              value={fmtCurrency(econ.cost_per_active_firm_30d)}
            />
            <StatBlock
              label="Cost / completed assessment"
              value={fmtCurrency(econ.cost_per_completed_assessment)}
              hint="lifetime"
            />
            <StatBlock
              label="Cost / engagement"
              value={fmtCurrency(econ.cost_per_engagement)}
              hint="lifetime"
            />
            <StatBlock label="AI spend (lifetime)" value={fmtCurrency(econ.ai_cost_total)} />
          </StatRow>
          <div>
            <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
              AI cost by day (last 30 days)
            </p>
            <AutoTable
              rows={s.ops.ai_cost_30d}
              initialSort={{ key: 'day', dir: 'desc' }}
              emptyLabel="No AI calls in the window"
            />
          </div>
        </div>
      </SectionCard>

      {/* Churn-risk book — firm last-activity + stalled engagements (docs/40 §4b) */}
      <SectionCard
        title="Churn-risk book"
        subtitle="Firm activity health and stalled delivery: the accounts at risk of churning"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <StatRow>
            <StatBlock label="Active firms" value={String(churn.active)} />
            <StatBlock label="Idle firms" value={String(churn.idle)} hint="quiet 30–60 days" />
            <StatBlock label="Dormant firms" value={String(churn.dormant)} />
            <StatBlock
              label="Paying at risk"
              value={String(churn.atRiskPaying)}
              hint="paying but idle / dormant"
            />
            <StatBlock
              label="Stalled engagements"
              value={String(toNumber(health.stalled_engagements))}
              hint={`${toNumber(health.active_engagements)} active`}
            />
          </StatRow>
          <div>
            <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
              Firm account book: dormant firms first
            </p>
            <FirmBook firms={s.business.firms} />
          </div>
        </div>
      </SectionCard>

      {/* Product & usage */}
      <SectionCard title="Product &amp; usage" subtitle="Top events over the last 30 days">
        {events.length === 0 ? (
          <EmptyState icon="empty" title="No usage events in the window" />
        ) : (
          <DataTable
            columns={[
              {
                key: 'label',
                header: 'Event',
                render: (r) => humanizeKey(r.label),
                sortValue: (r) => r.label,
              },
              { key: 'events', header: 'Events', numeric: true, sortValue: (r) => r.events },
              { key: 'firms', header: 'Firms (max/day)', numeric: true, sortValue: (r) => r.firms },
            ]}
            rows={events}
            keyFor={(r) => r.label}
            initialSort={{ key: 'events', dir: 'desc' }}
          />
        )}
      </SectionCard>

      {/* Moats / business plan */}
      <SectionCard
        title="Moats: the business plan"
        subtitle="Calibration corpus: the growth and predictive power of paired prediction/reality records (docs/40 §4a)"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {moatTiles.length === 0 ? (
            <EmptyState
              icon="clock"
              title="Calibration corpus is still empty"
            >
              Paired outcomes accrue as deals close; the KPIs light up once there are records.
            </EmptyState>
          ) : (
            <StatRow>
              {moatTiles.map((t) => (
                <StatBlock key={t.key} label={t.label} value={t.fmt(s.moats.corpus[t.key])} />
              ))}
            </StatRow>
          )}

          <div>
            <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
              Corpus growth by month
            </p>
            <AutoTable
              rows={s.moats.corpus_monthly}
              initialSort={{ key: 'month', dir: 'desc' }}
              emptyLabel="No monthly corpus data yet"
            />
          </div>

          <div>
            <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
              Verified financial corpus: coverage
            </p>
            <AutoTable rows={s.corpus.verified_coverage} emptyLabel="No verified coverage yet" />
          </div>

          {s.corpus.own_book_multiples.length > 0 && (
            <div>
              <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
                Own-book multiples
              </p>
              <AutoTable rows={s.corpus.own_book_multiples} />
            </div>
          )}
          {s.corpus.own_book_valuation_multiples.length > 0 && (
            <div>
              <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
                Own-book multiples: by valuation industry_key (recalibration signal)
              </p>
              <AutoTable rows={s.corpus.own_book_valuation_multiples} />
            </div>
          )}
          <p className="muted text-sm">{s.corpus.note}</p>
        </div>
      </SectionCard>

      {/* DRS calibration — the FICO moat (docs/09 §1): the versioned artifact */}
      <SectionCard
        title="DRS calibration"
        subtitle={
          s.calibration.calibration_version != null
            ? `Versioned calibration artifact v${s.calibration.calibration_version} · ${fmtDate(
                s.calibration.computed_at,
              )}. How each DRS/ORI band's predictions tracked reality across ${toNumber(
                s.calibration.total_closed,
              )} closed deals.`
            : 'How each DRS/ORI band’s predictions track reality across closed deals: the calibrated score (docs/09 §1).'
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <StatRow>
            <StatBlock
              label="Calibration version"
              value={s.calibration.calibration_version != null ? `v${s.calibration.calibration_version}` : '—'}
            />
            <StatBlock label="Outcomes in corpus" value={String(toNumber(s.calibration.total_outcomes))} />
            <StatBlock label="Closed deals" value={String(toNumber(s.calibration.total_closed))} />
            <StatBlock label="Contributing firms" value={String(toNumber(s.calibration.contributing_firms))} />
          </StatRow>

          {calDrsBands.length === 0 ? (
            <EmptyState icon="clock" title="No calibration computed yet">
              The versioned calibration artifact is produced by the superadmin
              <code> compute-calibration</code> function from the deal-outcomes corpus; DRS bands
              light up once it has run over closed deals.
            </EmptyState>
          ) : (
            <div>
              <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
                DRS score bands
              </p>
              <CalibrationBandsTable rows={calDrsBands} groupHeader="DRS band" />
            </div>
          )}

          {calOriBands.length > 0 && (
            <div>
              <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
                Owner Readiness Index bands
              </p>
              <CalibrationBandsTable rows={calOriBands} groupHeader="ORI band" />
            </div>
          )}
          <p className="muted text-sm">{s.calibration.note}</p>
        </div>
      </SectionCard>

      {/* Deliverable quality — ExitBlueprint Bench (docs/sellside-ai/02): a
          BigLaw-Bench-style scorecard of generated deliverables, per prompt version. */}
      <SectionCard
        title="Deliverable quality: ExitBlueprint Bench"
        subtitle={
          s.bench.last_run_at
            ? `Last run ${fmtDate(s.bench.last_run_at)}`
            : 'Not run yet'
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <p className="muted text-sm">
            Measured deliverable quality per prompt version: answer = % of an
            advisor-quality deliverable produced; source = % of claims traceable. Pass
            thresholds: answer ≥ 90%, source = 100%.
          </p>
          <BenchTable rows={s.bench.results} />
        </div>
      </SectionCard>

      {/* Ops — webhook health (AI cost/COGS lives in Unit economics above) */}
      <SectionCard title="Ops" subtitle="Webhook health: a stuck webhook is an outage /ready won't catch">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <div>
            <p className="stat-block-label" style={{ marginBottom: '0.5rem' }}>
              Webhook health
            </p>
            <AutoTable rows={s.ops.webhooks} emptyLabel="No webhook activity" />
          </div>
          <p className="muted text-sm">{s.ops.note}</p>
        </div>
      </SectionCard>

      {/* Security */}
      <SectionCard title="Security" subtitle="Data-access log rollup over 30 days">
        <AutoTable
          rows={s.security.access_30d}
          initialSort={{ key: 'day', dir: 'desc' }}
          emptyLabel="No access-log activity in the window"
        />
      </SectionCard>

      {/* Narrative prompt overrides — the only editable control on this rail. */}
      <PromptRegistryCard />

      <Card>
        <p className="muted text-sm">
          Read-only operator view over the service-role <code>analytics</code> schema
          (docs/38, docs/40). Uptime, request latency and error rates live in the hosting
          consoles (Render, Sentry, Vercel); dollar revenue lives in Stripe. This rail carries
          unit counts.
        </p>
      </Card>
    </div>
  );
}
