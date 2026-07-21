import { Link } from 'react-router-dom';
import { useOwnerContext } from '../../lib/owner';
import { useExplain, useEngagementGaps, useValuation, useVerification } from '../../lib/queries';
import { Card, EmptyState, ErrorState, GapSeverityChip, PageHeader, ScoreDial, SkeletonLines, TierBadge } from '../../components/ui';
import { EngagementComments } from '../../components/EngagementComments';
import { fmtCurrencyCompact, fmtScore } from '../../lib/format';

const TIER_PLAIN: Record<string, string> = {
  'Institutional Grade': 'Your business is in the strongest shape buyers look for.',
  'Sale Ready': 'Your business is in good shape to begin a sale process.',
  'Needs Work': 'There is meaningful work to do before going to market.',
  'High Risk': 'Significant gaps would concern a buyer today.',
  'Not Saleable (Yet)': 'The business is not ready to go to market yet — but there is a clear path.',
};

export default function OwnerHomePage() {
  const { company, engagement, latest, loading, isError, error, refetch } = useOwnerContext();
  const explainQ = useExplain(latest?.id);
  const gapsQ = useEngagementGaps(engagement?.id, latest?.rubric_version_id);
  const verifQ = useVerification(latest?.id);
  const valuationQ = useValuation(engagement?.id);
  const explain = explainQ.data;
  const val = valuationQ.data;

  if (loading) return <Card><SkeletonLines lines={6} /></Card>;

  // A failed load must not read as "your assessment is being prepared".
  if (isError) {
    return (
      <>
        <PageHeader title={company?.name ?? 'Welcome'} subtitle="Your exit-readiness workspace" />
        <ErrorState variant="section" error={error} onRetry={refetch} />
      </>
    );
  }

  if (!engagement || !latest) {
    return (
      <>
        <PageHeader title={company?.name ?? 'Welcome'} subtitle="Your exit-readiness workspace" />
        <EmptyState title="Your assessment is being prepared">
          Your advisor is setting up your readiness assessment. You'll see your score and plan here
          once it's ready.
        </EmptyState>
      </>
    );
  }

  const topGaps = (gapsQ.data ?? []).slice(0, 3);

  return (
    <div className="stack-lg">
      <PageHeader
        title={`Welcome back${company ? ` — ${company.name}` : ''}`}
        subtitle="Where your business stands today, and what we're working on together."
      />

      <div className="owner-hero">
        <Card>
          {explainQ.isError ? (
            <ErrorState variant="section" error={explainQ.error} onRetry={explainQ.refetch} />
          ) : !explain ? (
            <SkeletonLines lines={5} />
          ) : (
            <div className="owner-hero-inner">
              <div className="owner-hero-dial">
                <ScoreDial value={explain.drsScore} tier={explain.drsTier} size={148} />
                <TierBadge tier={explain.drsTier} />
              </div>
              <div className="owner-hero-copy">
                <p className="owner-hero-lead">{TIER_PLAIN[explain.drsTier] ?? ''}</p>
                <div className="owner-hero-stats">
                  <div>
                    <span className="owner-stat-num">{fmtScore(explain.drsScore)}</span>
                    <span className="owner-stat-label">Business readiness</span>
                  </div>
                  <div>
                    <span className="owner-stat-num">{fmtScore(explain.oriScore)}</span>
                    <span className="owner-stat-label">Your personal readiness</span>
                  </div>
                  {verifQ.data && (
                    <div>
                      <span className="owner-stat-num">{verifQ.data.pct}%</span>
                      <span className="owner-stat-label">Financials verified</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>

      {val?.has_recast && (
        <Card>
          <span className="stat-block-label">What your business could be worth</span>
          <div className="owner-value">
            <div className="owner-value-main">
              <span className="owner-value-num">{fmtCurrencyCompact(val.ev_base)}</span>
              <span className="muted">estimated enterprise value · range {fmtCurrencyCompact(val.ev_low)}–{fmtCurrencyCompact(val.ev_high)}</span>
            </div>
            <div className="owner-value-main">
              <span className="owner-value-num">{fmtCurrencyCompact(val.net_proceeds)}</span>
              <span className="muted">estimated net to you, after debt, costs, and taxes</span>
            </div>
            {val.owner_wealth_target != null && val.wealth_gap != null && (
              <div className="owner-value-main">
                <span className={`owner-value-num ${val.wealth_gap > 0 ? 'owner-value-short' : 'owner-value-ok'}`}>
                  {val.wealth_gap > 0 ? fmtCurrencyCompact(val.wealth_gap) : 'On track'}
                </span>
                <span className="muted">
                  {val.wealth_gap > 0 ? `to reach your ${fmtCurrencyCompact(val.owner_wealth_target)} goal` : `vs. your ${fmtCurrencyCompact(val.owner_wealth_target)} goal`}
                </span>
              </div>
            )}
          </div>
          <p className="muted text-sm" style={{ margin: '0.7rem 0 0', fontStyle: 'italic' }}>
            An estimate to guide planning — not an appraisal. Finishing your plan is worth about{' '}
            {fmtCurrencyCompact(val.value_creation_gap)} more in enterprise value.
          </p>
        </Card>
      )}

      <div className="owner-grid">
        <Card>
          <span className="stat-block-label">What we're focused on</span>
          {topGaps.length === 0 ? (
            <p className="muted" style={{ marginTop: '0.6rem' }}>No open priorities right now.</p>
          ) : (
            <ul className="owner-priorities">
              {topGaps.map((g) => (
                <li key={g.id}>
                  <GapSeverityChip severity={g.severity} />
                  <span><strong>{g.name}</strong>{g.playbookName && <span className="muted"> — {g.playbookName}</span>}</span>
                </li>
              ))}
            </ul>
          )}
          <Link className="owner-more" to="/portal/plan">See the full plan →</Link>
        </Card>

        <Card>
          <span className="stat-block-label">Your workspace</span>
          <div className="owner-links">
            <Link className="owner-link" to="/portal/plan">
              <span className="owner-link-title">Your plan</span>
              <span className="owner-link-sub">The roadmap your advisor built</span>
            </Link>
            <Link className="owner-link" to="/portal/learn">
              <span className="owner-link-title">Learn</span>
              <span className="owner-link-sub">Short guides tailored to your gaps</span>
            </Link>
            <Link className="owner-link" to="/portal/documents">
              <span className="owner-link-title">Documents</span>
              <span className="owner-link-sub">Your readiness reports</span>
            </Link>
          </div>
        </Card>
      </div>

      <EngagementComments engagementId={engagement.id} />
    </div>
  );
}
