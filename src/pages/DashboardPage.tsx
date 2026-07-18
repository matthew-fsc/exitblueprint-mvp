import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DataTable,
  DeltaChip,
  EmptyState,
  PageHeader,
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
          {r.industry && <span className="muted" style={{ display: 'block', fontSize: '0.78rem' }}>{r.industry}</span>}
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

  return (
    <div className="stack-lg">
      <PageHeader
        title="Portfolio"
        subtitle="Exit-readiness engagements across your book, ordered by attention needed."
      />

      <StatRow>
        <StatBlock label="Engagements" value={rows.length} />
        <StatBlock label="Average DRS" value={avgDrs ?? '—'} />
        <StatBlock label="Movers this quarter" value={movers} hint="up ≥ 3 points vs prior" />
        <StatBlock
          label="Stale ≥ 90 days"
          value={staleCount}
          hint={staleCount > 0 ? 'need a reassessment' : 'all current'}
        />
      </StatRow>

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
        <span className="filter-count muted">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        keyFor={(r) => r.engagementId}
        onRowClick={(r) => navigate(`/engagement/${r.engagementId}`)}
        loading={portfolioQ.isLoading}
        error={portfolioQ.error?.message ?? null}
        initialSort={{ key: 'stale', dir: 'desc' }}
        empty={
          <EmptyState title="No engagements yet" action={<button onClick={() => navigate('/clients')}>Add your first client</button>}>
            Add a company and open a readiness engagement to start tracking it here.
          </EmptyState>
        }
      />
    </div>
  );
}
