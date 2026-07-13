import { Link } from 'react-router-dom';
import { useOwnerContext } from '../../lib/owner';
import { useExplain, useEngagementGaps, useVerification } from '../../lib/queries';
import { Card, EmptyState, PageHeader, ScoreDial, SkeletonLines, TierBadge } from '../../components/ui';
import { fmtScore } from '../../lib/format';

const TIER_PLAIN: Record<string, string> = {
  'Institutional Grade': 'Your business is in the strongest shape buyers look for.',
  'Sale Ready': 'Your business is in good shape to begin a sale process.',
  'Needs Work': 'There is meaningful work to do before going to market.',
  'High Risk': 'Significant gaps would concern a buyer today.',
  'Not Saleable (Yet)': 'The business is not ready to go to market yet — but there is a clear path.',
};

export default function OwnerHomePage() {
  const { company, engagement, latest, loading } = useOwnerContext();
  const explainQ = useExplain(latest?.id);
  const gapsQ = useEngagementGaps(engagement?.id, latest?.rubric_version_id);
  const verifQ = useVerification(latest?.id);
  const explain = explainQ.data;

  if (loading) return <Card><SkeletonLines lines={6} /></Card>;

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
          {!explain ? (
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

      <div className="owner-grid">
        <Card>
          <span className="stat-block-label">What we're focused on</span>
          {topGaps.length === 0 ? (
            <p className="muted" style={{ marginTop: '0.6rem' }}>No open priorities right now — nicely done.</p>
          ) : (
            <ul className="owner-priorities">
              {topGaps.map((g) => (
                <li key={g.id}>
                  <span className={`gap-chip gap-${g.severity === 'critical' ? 'critical' : g.severity === 'high' ? 'serious' : g.severity === 'med' ? 'warning' : 'neutral'}`}>
                    {g.severity}
                  </span>
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
            <Link className="owner-link" to="/portal/connect">
              <span className="owner-link-title">Connect accounting</span>
              <span className="owner-link-sub">Verify your financials in one click</span>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
