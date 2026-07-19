import { useEffect, useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { track } from '../lib/analytics';
import {
  useActiveAssessment,
  useCompany,
  useEngagement,
  useExplain,
  useRubricVersion,
} from '../lib/queries';
import {
  Card,
  Collapsible,
  EngagementNav,
  PageSection,
  EmptyState,
  GapSeverityChip,
  PageHeader,
  ScoreDial,
  SkeletonLines,
  TierBadge,
} from '../components/ui';
import { bySeverity } from '../lib/severity';
import { fmtDate, fmtScore } from '../lib/format';
import {
  consensus,
  gapReason,
  gapToTarget,
  interpretSubScore,
  subScoreGaps,
} from '../../shared/scoring/interpret';


const TIERS = [
  { label: 'Institutional Grade', floor: 85 },
  { label: 'Sale Ready', floor: 70 },
  { label: 'Needs Work', floor: 55 },
  { label: 'High Risk', floor: 40 },
  { label: 'Not Saleable (Yet)', floor: 0 },
];

export default function ResultsPage() {
  const { assessmentId } = useParams();
  const { profile } = useAuth();
  const assessmentQ = useActiveAssessment(assessmentId);
  const assessment = assessmentQ.data ?? null;
  const engagementQ = useEngagement(assessment?.engagement_id);
  const companyQ = useCompany(engagementQ.data?.company_id);

  // R6: score delivery — record that the advisor viewed the DRS results (what
  // they do next shows up as later events in the same session). Fires once.
  const viewTracked = useRef(false);
  useEffect(() => {
    if (!viewTracked.current && engagementQ.data && assessment) {
      viewTracked.current = true;
      track({
        type: 'report',
        name: 'results_viewed',
        firmId: engagementQ.data.firm_id,
        profileId: profile?.id,
        engagementId: assessment.engagement_id,
        properties: { assessment_id: assessmentId, drs: assessment.drs_score, tier: assessment.drs_tier },
      });
    }
  }, [engagementQ.data, assessment, assessmentId, profile?.id]);
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
      <EmptyState icon="warning" title="Couldn’t load results">
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

  // Path to 100: the whole gap from today's DRS to a perfect score, decomposed
  // across the six dimensions and ranked by how many points each holds. Every
  // figure traces to the same weights the engine used (see gapToTarget).
  const gap = gapToTarget(explain.drsScore, explain.dimensions);
  const dimStatusFor = (score: number): 'good' | 'ok' | 'warning' | 'critical' =>
    score >= 75 ? 'good' : score >= 55 ? 'ok' : score >= 40 ? 'warning' : 'critical';
  // The next tier up — so the gap reads as "N points to the next rung", not only
  // to an abstract 100.
  const nextTier = [...TIERS].reverse().find((t) => t.floor > explain.drsScore);
  const roadmapTo = `/engagement/${assessment.engagement_id}/roadmap`;

  return (
    <div className="results page-shell">
      <header className="page-masthead">
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
      <EngagementNav engagementId={assessment.engagement_id} />
      </header>

      <PageSection title="Readiness" note="Business and owner readiness, scored separately">
      <div className="stack-lg">
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

      {/* Score summary — the dial anchors the left; the two readings stack on the
          right so they fill the dial's height rather than floating in tall tiles. */}
      <section className="score-summary">
        <div className="tile score-tile score-tile-dial">
          <span className="tile-label">Business readiness</span>
          <ScoreDial value={explain.drsScore} tier={explain.drsTier} />
          <TierBadge tier={explain.drsTier} />
          <span className="muted tile-note">Diligence Readiness Score, out of 100</span>
        </div>
        <div className="score-summary-side">
          <div className="tile score-tile">
            <span className="tile-label">Owner readiness</span>
            <span className="tile-value hero-tile-value">{fmtScore(explain.oriScore)}</span>
            <span className="muted tile-note">
              The owner’s personal and financial readiness, scored on its own — never blended into
              the business score.
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
        </div>
      </section>

      <Collapsible title="How this score is built">
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
      </Collapsible>
      </div>
      </PageSection>

      <PageSection
        title="Path to 100"
        note={gap.totalGap > 0 ? `${fmtScore(gap.totalGap)} points to recover` : 'At a perfect score'}
      >
      {gap.totalGap <= 0 ? (
        <p className="gap-none">Business readiness is at a perfect 100 — every point is captured.</p>
      ) : (
        <div className="stack-lg">
          {/* The whole gap, in one view: how much of a perfect 100 is captured
              today, and how the missing points split across the six areas. */}
          <div className="gap-summary">
            <div className="gap-summary-head">
              <span className="gap-summary-figures">
                <span className="gap-current">{fmtScore(explain.drsScore)}</span>
                <span className="gap-arrow" aria-hidden>→</span>
                <span className="gap-target">100</span>
              </span>
              <p className="gap-summary-caption muted">
                <strong>{fmtScore(gap.totalGap)} points</strong> stand between today’s business
                readiness and a perfect score
                {nextTier ? (
                  <>
                    {' '}— {fmtScore(nextTier.floor - explain.drsScore)} of them reach the{' '}
                    <strong>{nextTier.label}</strong> tier.
                  </>
                ) : (
                  '.'
                )}
              </p>
            </div>
            {/* Composition bar: the captured score, then a segment per dimension
                sized to the points it holds, worst areas coloured to draw the eye. */}
            <div
              className="gap-bar"
              role="img"
              aria-label={`${fmtScore(explain.drsScore)} of 100 captured; ${fmtScore(gap.totalGap)} points open across the business areas`}
            >
              <span
                className="gap-seg gap-seg-captured"
                style={{ width: `${explain.drsScore}%` }}
                title={`Captured today: ${fmtScore(explain.drsScore)} points`}
              />
              {gap.dimensions
                .filter((d) => d.recoverablePoints > 0)
                .map((d) => (
                  <span
                    key={d.code}
                    className={`gap-seg gap-seg-${dimStatusFor(d.score)}`}
                    style={{ width: `${d.recoverablePoints}%` }}
                    title={`${d.name}: ${fmtScore(d.recoverablePoints)} points open`}
                  />
                ))}
            </div>
          </div>

          {/* Ranked breakdown: biggest opportunity first, each expanding to the
              specific measures behind it and what each is worth in DRS points. */}
          <div className="dimension-list">
            {gap.dimensions.map((d, i) => {
              const subs = explain.subScores.filter((s) => s.dimensionCode === d.code);
              const readings = subScoreGaps(subs, d.drsWeight);
              const dimStatus = dimStatusFor(d.score);
              const captured = d.maxContributionToDrs > 0
                ? (d.contributionToDrs / d.maxContributionToDrs) * 100
                : 100;
              return (
                <details key={d.code} className="dim-card" open={i === 0 && d.recoverablePoints > 0}>
                  <summary>
                    <span className="dim-head dim-head-gap">
                      <span className="dim-name">
                        <span className="dim-rank" aria-hidden>{i + 1}</span>
                        {d.name}
                      </span>
                      <span className="dim-track" title={`${fmtScore(d.contributionToDrs)} of ${fmtScore(d.maxContributionToDrs)} DRS points captured`}>
                        <span className={`dim-fill dim-fill-${dimStatus}`} style={{ width: `${captured}%` }} />
                      </span>
                      <span className={`gap-open-chip gap-open-${dimStatus}`}>
                        {d.recoverablePoints > 0 ? `+${fmtScore(d.recoverablePoints)} open` : 'maxed'}
                      </span>
                    </span>
                    <span className="dim-expand">details</span>
                  </summary>
                  <div className="dim-body">
                    <p className="dim-contrib muted">
                      Worth {Math.round(d.drsWeight * 100)}% of the business score. It adds{' '}
                      {fmtScore(d.contributionToDrs)} of a possible {fmtScore(d.maxContributionToDrs)}{' '}
                      DRS points today — <strong>{fmtScore(d.recoverablePoints)} still on the table.</strong>
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
                          <span className="factor-opp" title="DRS points recovering this to full marks would add">
                            {r.recoverableDrsPoints > 0 ? `+${fmtScore(r.recoverableDrsPoints)}` : '—'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              );
            })}
          </div>

          {/* The gap view lands on the next action: turn it into a plan. */}
          <div className="remediation-cta">
            <div className="remediation-cta-body">
              <span className="remediation-cta-label">Close the gap</span>
              <p>
                These are the raw material for remediation. The roadmap sequences them — most
                valuable points first — into tasks for the owner and deal team.
              </p>
            </div>
            <Link className="button-link button-primary" to={roadmapTo}>
              Build the remediation roadmap →
            </Link>
          </div>
        </div>
      )}
      </PageSection>

      <PageSection title="Owner readiness" note="Scored separately from the business">
        <p className="section-sub muted" style={{ marginTop: 0 }}>
          A ready business and an unready owner is a common — and important — mismatch.
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
      </PageSection>

      <PageSection
        title="What buyers would flag"
        note={explain.firedGaps.length > 0 ? `${explain.firedGaps.length} flagged` : 'None flagged'}
      >
      {explain.firedGaps.length === 0 && <p className="gap-none">No gaps flagged.</p>}
      <ul className="gap-detail-list">
        {[...explain.firedGaps]
          .sort(bySeverity)
          .map((g) => (
          <li key={g.code}>
            <GapSeverityChip severity={g.severity} />
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
      </PageSection>
    </div>
  );
}
