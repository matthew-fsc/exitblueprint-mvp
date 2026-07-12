import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import {
  useActiveAssessment,
  useCompany,
  useEngagement,
  useExplain,
  useRubricVersion,
} from '../lib/queries';
import {
  Card,
  EmptyState,
  PageHeader,
  ScoreDial,
  SkeletonLines,
  TierBadge,
} from '../components/ui';
import { fmtDate, fmtScore } from '../lib/format';
import {
  consensus,
  gapReason,
  interpretSubScore,
} from '../../shared/scoring/interpret';

const severityStatus: Record<string, string> = {
  critical: 'critical',
  high: 'serious',
  med: 'warning',
  low: 'neutral',
};

const TIERS = [
  { label: 'Institutional Grade', floor: 85 },
  { label: 'Sale Ready', floor: 70 },
  { label: 'Needs Work', floor: 55 },
  { label: 'High Risk', floor: 40 },
  { label: 'Not Saleable (Yet)', floor: 0 },
];

export default function ResultsPage() {
  const { assessmentId } = useParams();
  const assessmentQ = useActiveAssessment(assessmentId);
  const assessment = assessmentQ.data ?? null;
  const engagementQ = useEngagement(assessment?.engagement_id);
  const companyQ = useCompany(engagementQ.data?.company_id);
  const versionQ = useRubricVersion(assessment?.rubric_version_id);
  const explainQ = useExplain(assessmentId);
  const explain = explainQ.data;

  const ownerDimsQ = useQuery({
    queryKey: ['ownerDims', assessment?.rubric_version_id ?? ''],
    enabled: !!assessment?.rubric_version_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('dimensions')
        .select('*')
        .eq('rubric_version_id', assessment!.rubric_version_id)
        .eq('score_group', 'owner_readiness');
      if (error) throw new Error(error.message);
      return new Map((data ?? []).map((d: { code: string; name: string }) => [d.code, d.name]));
    },
  });
  const ownerDimNames = ownerDimsQ.data ?? new Map<string, string>();

  const subScoreNames = useMemo(
    () => new Map((explain?.subScores ?? []).map((s) => [s.code, s.name])),
    [explain],
  );

  if (assessmentQ.isLoading || explainQ.isLoading) {
    return (
      <Card>
        <SkeletonLines lines={6} />
      </Card>
    );
  }
  if (assessmentQ.error || explainQ.error) {
    return (
      <EmptyState icon="⚠" title="Couldn’t load results">
        {(assessmentQ.error ?? explainQ.error)?.message}
      </EmptyState>
    );
  }
  if (!assessment || !explain) return <EmptyState title="Results not available" />;

  const companyName = companyQ.data?.name ?? '';
  const versionLabel = versionQ.data?.version_label ?? '';
  const divergent = Math.abs(explain.drsScore - explain.oriScore) >= 15;
  const ownerSubs = explain.subScores.filter((s) => ownerDimNames.has(s.dimensionCode));
  const ownerGroups = [...ownerDimNames.keys()]
    .map((code) => ({
      code,
      name: ownerDimNames.get(code)!,
      subs: ownerSubs.filter((s) => s.dimensionCode === code),
    }))
    .filter((g) => g.subs.length > 0);

  return (
    <div className="results">
      <PageHeader
        title={
          <>
            {companyName} <span className="muted">· assessment #{assessment.sequence_number}</span>
          </>
        }
        crumbs={[
          { label: 'Portfolio', to: '/' },
          { label: companyName, to: `/engagement/${assessment.engagement_id}` },
          { label: `Assessment #${assessment.sequence_number}` },
        ]}
        subtitle={
          <>
            {versionLabel}
            {assessment.completed_at ? ` · ${fmtDate(assessment.completed_at)}` : ''}
          </>
        }
        actions={
          <>
            <Link className="button-link" to={`/assessment/${assessment.id}/workbench`}>
              What-if →
            </Link>
            <Link className="button-link" to={`/assessment/${assessment.id}/report`}>
              Owner report →
            </Link>
          </>
        }
      />

      {/* Consensus — the synthesized bottom line */}
      <div className="consensus-callout">
        <span className="consensus-label">Bottom line</span>
        <p>
          {
            consensus({
              drsScore: explain.drsScore,
              drsTier: explain.drsTier,
              oriScore: explain.oriScore,
              dimensions: explain.dimensions.map((d) => ({ code: d.code, name: d.name, score: d.score })),
              firedGaps: explain.firedGaps,
            }).bottomLine
          }
        </p>
      </div>

      {/* Score summary */}
      <section className="score-tiles">
        <div className="tile score-tile" style={{ alignItems: 'center' }}>
          <span className="tile-label">Business readiness</span>
          <ScoreDial value={explain.drsScore} tier={explain.drsTier} />
          <TierBadge tier={explain.drsTier} />
          <span className="muted tile-note">Diligence Readiness Score, out of 100</span>
        </div>
        <div className="tile score-tile">
          <span className="tile-label">Owner readiness</span>
          <span className="tile-value hero-tile-value">{fmtScore(explain.oriScore)}</span>
          <span className="muted tile-note">
            The owner’s personal and financial readiness, scored on its own — never blended into the
            business score.
          </span>
        </div>
        <div className={`tile score-tile ${divergent ? 'tile-flag' : ''}`}>
          <span className="tile-label">Reading the two together</span>
          <span className="tile-narrative">
            {divergent
              ? 'The business and the owner are at different stages of readiness. That gap is a finding in itself: the plan should move both forward, not just one.'
              : 'The business and the owner are broadly aligned in readiness.'}
          </span>
        </div>
      </section>

      <details className="how-it-works">
        <summary>How this score is built</summary>
        <div className="how-body">
          <p>
            Six areas of the business are each scored out of 100 from your assessment answers. Those
            six roll up — weighted by how much buyers care about each — into the single{' '}
            <strong>Business readiness</strong> score above. The owner’s personal readiness is scored
            separately and never mixed in.
          </p>
          <p className="muted">
            Every number below traces straight back to an answer you gave. Nothing is estimated, and
            no AI is involved in the scoring — the same answers always produce the same score.
          </p>
          <div className="tier-ladder">
            {TIERS.map((t) => (
              <div
                key={t.label}
                className={`tier-rung ${t.label === explain.drsTier ? 'tier-rung-current' : ''}`}
              >
                <span className="tier-floor">{t.floor}+</span>
                <span className="tier-name">{t.label}</span>
                {t.label === explain.drsTier && <span className="tier-you">you are here</span>}
              </div>
            ))}
          </div>
        </div>
      </details>

      <h3 className="section-heading">The six business areas</h3>
      <p className="section-sub muted">
        Open any area to see, in plain terms, what it measures and what your answers showed.
      </p>
      <div className="dimension-list">
        {explain.dimensions.map((d) => {
          const readings = explain.subScores
            .filter((s) => s.dimensionCode === d.code)
            .map(interpretSubScore)
            .sort((a, b) => a.points - b.points);
          const dimStatus =
            d.score >= 75 ? 'good' : d.score >= 55 ? 'ok' : d.score >= 40 ? 'warning' : 'critical';
          return (
            <details key={d.code} className="dim-card">
              <summary>
                <span className="dim-head">
                  <span className="dim-name">{d.name}</span>
                  <span className="dim-track">
                    <span className={`dim-fill dim-fill-${dimStatus}`} style={{ width: `${d.score}%` }} />
                  </span>
                  <span className="dim-value">{fmtScore(d.score)}</span>
                </span>
                <span className="dim-expand">details</span>
              </summary>
              <div className="dim-body">
                <p className="dim-contrib muted">
                  This area is worth {Math.round(d.drsWeight * 100)}% of the business score, so it adds{' '}
                  {d.contributionToDrs} of the {explain.drsScore} points overall.
                </p>
                <ul className="factor-list">
                  {readings.map((r) => (
                    <li key={r.code} className="factor">
                      <span className={`factor-badge status-${r.band.status}`}>{r.band.label}</span>
                      <span className="factor-text">
                        <strong>{r.name}</strong> — {r.measures}.
                        <span className="factor-reading"> {r.reading}</span>
                        <span className="factor-benchmark muted"> Target: {r.benchmark}.</span>
                      </span>
                      <span className="factor-score">{r.points}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          );
        })}
      </div>

      <h3 className="section-heading">The owner’s side</h3>
      <p className="section-sub muted">
        Scored separately from the business. A ready business and an unready owner is a common — and
        important — mismatch.
      </p>
      <div className="dimension-list">
        {ownerGroups.map((g) => (
          <div key={g.code} className="owner-card">
            <h4>{g.name}</h4>
            <ul className="factor-list">
              {g.subs.map(interpretSubScore).map((r) => (
                <li key={r.code} className="factor">
                  <span className={`factor-badge status-${r.band.status}`}>{r.band.label}</span>
                  <span className="factor-text">
                    <strong>{r.name}</strong>
                    <span className="factor-reading"> {r.reading}</span>
                  </span>
                  <span className="factor-score">{r.points}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <h3 className="section-heading">
        What buyers would flag <span className="count-pill">{explain.firedGaps.length}</span>
      </h3>
      {explain.firedGaps.length === 0 && <p className="gap-none">No gaps flagged — a clean assessment.</p>}
      <ul className="gap-detail-list">
        {explain.firedGaps.map((g) => (
          <li key={g.code}>
            <span className={`gap-chip gap-${severityStatus[g.severity] ?? 'neutral'}`}>{g.severity}</span>
            <span className="gap-text">
              <strong>{g.name}</strong>
              <span className="muted"> {gapReason(g.trigger, subScoreNames)}</span>
            </span>
          </li>
        ))}
        {explain.flags.map((f) => (
          <li key={f}>
            <span className="gap-chip gap-neutral">note</span>
            <span className="gap-text">
              <strong>{f}</strong>
              <span className="muted"> Scored conservatively until it is measured.</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
