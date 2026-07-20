import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DataTable,
  DeltaChip,
  EmptyState,
  PageHeader,
  PageSection,
  Sparkline,
  StatBlock,
  StatRow,
  TierBadge,
  type Column,
} from '../components/ui';
import { usePortfolio, type PortfolioRow } from '../lib/queries';
import { TIER_ORDER } from '../lib/tokens';
import { daysSince, fmtScore } from '../lib/format';

const STALE_DAYS = 90;

type TierFilter = 'all' | (typeof TIER_ORDER)[number];
type MoveFilter = 'all' | 'up' | 'down' | 'stale';

export default function DashboardPage() {
  const navigate = useNavigate();
  const portfolioQ = usePortfolio();
  const rows = portfolioQ.data ?? [];
  const [tier, setTier] = useState<TierFilter>('all');
  const [move, setMove] = useState<MoveFilter>('all');

  const assessed = rows.filter((r) => r.latestDrs != null);
  const avgDrs = assessed.length
    ? Math.round((assessed.reduce((a, r) => a + (r.latestDrs ?? 0), 0) / assessed.length) * 10) / 10
    : null;
  const movers = rows.filter((r) => (r.delta ?? 0) >= 3).length;
  const staleCount = rows.filter((r) => {
    const d = daysSince(r.latestAt);
    return r.latestAt != null && d != null && d >= STALE_DAYS;
  }).length;

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (tier !== 'all' && r.latestTier !== tier) return false;
      const d = daysSince(r.latestAt);
      if (move === 'up' && !((r.delta ?? 0) > 0)) return false;
      if (move === 'down' && !((r.delta ?? 0) < 0)) return false;
      if (move === 'stale' && !(r.latestAt != null && d != null && d >= STALE_DAYS)) return false;
      return true;
    });
  }, [rows, tier, move]);

  const columns: Column<PortfolioRow>[] = [
    {
      key: 'company',
      header: 'Client',
      sortValue: (r) => r.companyName.toLowerCase(),
      render: (r) => (
        <span>
          <strong>{r.companyName}</strong>
          {r.industry && <span className="muted text-sm" style={{ display: 'block' }}>{r.industry}</span>}
        </span>
      ),
    },
    {
      key: 'drs',
      header: 'DRS',
      numeric: true,
      sortValue: (r) => r.latestDrs ?? -1,
      render: (r) => (r.latestDrs != null ? <strong>{fmtScore(r.latestDrs)}</strong> : <span className="muted">—</span>),
    },
    {
      key: 'tier',
      header: 'Tier',
      sortValue: (r) => (r.latestTier ? TIER_ORDER.indexOf(r.latestTier as (typeof TIER_ORDER)[number]) : -1),
      render: (r) => (r.latestTier ? <TierBadge tier={r.latestTier} size="sm" /> : <span className="muted">no assessment</span>),
    },
    {
      key: 'delta',
      header: 'Δ since prior',
      numeric: true,
      sortValue: (r) => r.delta ?? 0,
      render: (r) =>
        r.deltaState === 'value' ? (
          <DeltaChip value={r.delta} />
        ) : r.deltaState === 'incomparable' ? (
          <span className="muted" title="Prior assessment used a different rubric version — scores are not comparable" style={{ whiteSpace: 'nowrap' }}>
            new rubric
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'trend',
      header: 'Trend',
      render: (r) => <Sparkline points={r.points} />,
    },
    {
      key: 'gaps',
      header: 'Open gaps',
      numeric: true,
      sortValue: (r) => r.openGaps,
      render: (r) => (r.openGaps > 0 ? <span className="count-pill">{r.openGaps}</span> : <span className="muted">0</span>),
    },
    {
      key: 'stale',
      header: 'Last assessed',
      numeric: true,
      sortValue: (r) => daysSince(r.latestAt) ?? 99999,
      render: (r) => {
        const d = daysSince(r.latestAt);
        if (r.latestAt == null || d == null) return <span className="muted">never</span>;
        const stale = d >= STALE_DAYS;
        return (
          <span className={stale ? 'stale-flag' : 'muted'} style={{ whiteSpace: 'nowrap' }}>
            {d}d ago{stale ? ' · stale' : ''}
          </span>
        );
      },
    },
  ];

  const isLoading = portfolioQ.isLoading;
  const filtersActive = tier !== 'all' || move !== 'all';
  // Two distinct empty states: a genuinely empty book vs. filters that excluded
  // everything — telling a user with a full book to "add your first client"
  // would be a misleading dead end.
  const emptyNode = filtersActive ? (
    <EmptyState
      icon="search"
      title="No engagements match these filters"
      action={
        <button
          className="btn-secondary"
          onClick={() => {
            setTier('all');
            setMove('all');
          }}
        >
          Clear filters
        </button>
      }
    >
      No engagement in your book matches the current tier and movement filters.
    </EmptyState>
  ) : (
    <EmptyState
      title="No engagements yet"
      action={<button onClick={() => navigate('/clients')}>Add your first client</button>}
    >
      Add a company and open a readiness engagement to start tracking it here.
    </EmptyState>
  );

  return (
    <div className="page-shell">
      <header className="page-masthead">
        <PageHeader
          title="Portfolio"
          subtitle="Exit-readiness engagements across your book, ordered by attention needed."
        />
      </header>

      <PageSection title="Book at a glance" note="Where the engagement stands today">
        <StatRow>
          <StatBlock label="Engagements" value={isLoading ? '—' : rows.length} hint="active in your book" />
          <StatBlock label="Average DRS" value={isLoading ? '—' : avgDrs ?? '—'} hint="across the book" />
          <StatBlock label="Movers this quarter" value={isLoading ? '—' : movers} hint="up ≥ 3 points vs prior" />
          <StatBlock
            label="Stale ≥ 90 days"
            value={isLoading ? '—' : staleCount}
            hint={isLoading ? 'across the book' : staleCount > 0 ? 'need a reassessment' : 'all current'}
          />
        </StatRow>
      </PageSection>

      <PageSection
        title="Engagements"
        note={!isLoading && rows.length > 0 ? `${filtered.length} of ${rows.length} shown` : undefined}
      >
        <div className="filter-row">
          <label className="filter-control">
            <span className="filter-label">Tier</span>
            <select value={tier} onChange={(e) => setTier(e.target.value as TierFilter)}>
              <option value="all">All tiers</option>
              {TIER_ORDER.slice().reverse().map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-control">
            <span className="filter-label">Show</span>
            <select value={move} onChange={(e) => setMove(e.target.value as MoveFilter)}>
              <option value="all">Everything</option>
              <option value="up">Improving</option>
              <option value="down">Declining</option>
              <option value="stale">Stale (≥ 90 days)</option>
            </select>
          </label>
        </div>

        <DataTable
          columns={columns}
          rows={filtered}
          keyFor={(r) => r.engagementId}
          onRowClick={(r) => navigate(`/engagement/${r.engagementId}`)}
          loading={isLoading}
          error={portfolioQ.error?.message ?? null}
          initialSort={{ key: 'stale', dir: 'desc' }}
          empty={emptyNode}
        />
      </PageSection>
    </div>
  );
}
