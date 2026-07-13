import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { loadActiveRubricVersion } from '../lib/rubric';
import { supabase } from '../lib/supabase';
import {
  qk,
  useAssessmentsByEngagement,
  useCompany,
  useCompare,
  useEngagement,
  useEngagementDocuments,
  useEngagementGaps,
  useGapBurndown,
  useVerification,
  useEngagementOutcome,
  useExplain,
  type AssessmentRow,
} from '../lib/queries';
import {
  Card,
  DataTable,
  DeltaChip,
  DimensionBars,
  EmptyState,
  PageHeader,
  ScoreDial,
  SkeletonLines,
  TierBadge,
  ExitPaceChart,
  ContributionBars,
  DivergenceMeter,
  GapBurndown,
  type Column,
  type PacePoint,
} from '../components/ui';
import { VerificationCard } from '../components/VerificationCard';
import { AccountingCard } from '../components/AccountingCard';
import { OwnerAccessCard } from '../components/OwnerAccessCard';
import { fmtDate, fmtScore } from '../lib/format';

// Methodology target: "Competitive Process Ready" at DRS 85 (docs/07). Shown as
// the aspiration line on the trajectory.
const TARGET_DRS = 85;

// Turn a target-exit window ("24-36 months", "under 12 months") into a concrete
// date: engagement start + the earliest month in the window (the "ready by"
// date). Falls back to 24 months when the window is missing or unparseable.
function targetExitDate(startedAt: string, window: string | null): Date {
  const months = Number(window?.match(/\d+/)?.[0] ?? 24);
  const d = new Date(startedAt);
  d.setMonth(d.getMonth() + (Number.isFinite(months) ? months : 24));
  return d;
}

const PROCESS_LABEL: Record<string, string> = {
  not_in_market: 'Not in market',
  preparing: 'Preparing',
  in_market: 'In market',
  under_loi: 'Under LOI',
  closed: 'Closed',
  withdrawn: 'Withdrawn',
  broken: 'Broken',
};

export default function EngagementPage() {
  const { engagementId } = useParams();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const engagementQ = useEngagement(engagementId);
  const engagement = engagementQ.data ?? null;
  const companyQ = useCompany(engagement?.company_id);
  const assessmentsQ = useAssessmentsByEngagement(engagementId);
  const assessments = assessmentsQ.data ?? [];
  const outcomeQ = useEngagementOutcome(engagementId);
  const documentsQ = useEngagementDocuments(engagementId);
  const [error, setError] = useState<string | null>(null);

  const completed = assessments.filter((a) => a.status === 'completed' && a.drs_score != null);
  const latest = completed[completed.length - 1] ?? null;
  const gapsQ = useEngagementGaps(engagementId, latest?.rubric_version_id);
  const burndownQ = useGapBurndown(engagementId, latest?.rubric_version_id);
  const verifQ = useVerification(latest?.id);
  const explainQ = useExplain(latest?.id);

  const startAssessment = async () => {
    setError(null);
    try {
      const rubricVersion = await loadActiveRubricVersion();
      const { data: last } = await supabase
        .from('assessments')
        .select('*')
        .eq('engagement_id', engagementId!)
        .order('sequence_number', { ascending: false })
        .limit(1);
      const nextSequence = (last?.[0]?.sequence_number ?? 0) + 1;
      const { data, error } = await supabase
        .from('assessments')
        .insert([
          {
            firm_id: engagement!.firm_id,
            engagement_id: engagementId,
            rubric_version_id: rubricVersion.id,
            sequence_number: nextSequence,
          },
        ])
        .select()
        .single();
      if (error) throw new Error(error.message);
      qc.invalidateQueries({ queryKey: qk.assessmentsByEngagement(engagementId!) });
      navigate(`/assessment/${data.id}/intake`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (engagementQ.isLoading) {
    return (
      <Card>
        <SkeletonLines lines={4} />
      </Card>
    );
  }
  if (!engagement) return <p className="form-error">{engagementQ.error?.message ?? 'Engagement not found'}</p>;

  const companyName = companyQ.data?.name ?? '';
  const inProgress = assessments.find((a) => a.status === 'in_progress');
  const pacePoints: PacePoint[] = completed
    .filter((a) => a.completed_at)
    .map((a) => ({
      date: a.completed_at as string,
      score: Number(a.drs_score),
      tier: a.drs_tier ?? undefined,
    }));
  const exitDate = targetExitDate(engagement.started_at, engagement.target_exit_window);
  const delta =
    completed.length > 1
      ? Number(completed[completed.length - 1].drs_score) - Number(completed[0].drs_score)
      : null;
  const explain = explainQ.data;
  const outcomeStatus = outcomeQ.data?.process_status ?? null;
  const documents = documentsQ.data ?? [];

  return (
    <div>
      <PageHeader
        title={companyName}
        crumbs={[{ label: 'Portfolio', to: '/' }, { label: companyName }]}
        subtitle={
          <>
            Engagement {engagement.status}
            {engagement.target_exit_window ? ` · target window ${engagement.target_exit_window}` : ''}
            {outcomeStatus ? ` · ${PROCESS_LABEL[outcomeStatus] ?? outcomeStatus}` : ''}
          </>
        }
        actions={
          <>
            {completed.length > 0 && (
              <Link className="button-link" to={`/engagement/${engagementId}/valuation`}>
                Valuation →
              </Link>
            )}
            {completed.length > 0 && (
              <Link className="button-link" to={`/engagement/${engagementId}/buyer-lens`}>
                Buyer lens →
              </Link>
            )}
            {completed.length > 0 && (
              <Link className="button-link" to={`/engagement/${engagementId}/roadmap`}>
                Roadmap →
              </Link>
            )}
            {completed.length > 0 && (
              <Link className="button-link" to={`/engagement/${engagementId}/delta`}>
                Delta report →
              </Link>
            )}
            {!inProgress && profile ? (
              <button onClick={startAssessment}>
                {assessments.length === 0 ? 'Start baseline assessment' : 'Start re-assessment'}
              </button>
            ) : (
              inProgress && (
                <Link className="button-link" to={`/assessment/${inProgress.id}/intake`}>
                  Resume intake →
                </Link>
              )
            )}
          </>
        }
      />
      {error && <p className="form-error">{error}</p>}

      {completed.length > 0 ? (
        <>
          <Card>
            <div className="trajectory-head">
              <h3 className="section-heading" style={{ margin: 0 }}>
                On pace for the exit window?
              </h3>
              {delta !== null && <DeltaChip value={delta} />}
            </div>
            <p className="muted" style={{ margin: '0.25rem 0 0' }}>
              Readiness plotted against the target exit date, with the pace needed to reach
              Competitive-Process-Ready (DRS {TARGET_DRS}) in time.
            </p>
            <div style={{ marginTop: '0.75rem' }}>
              <ExitPaceChart
                points={pacePoints}
                targetScore={TARGET_DRS}
                targetDate={exitDate}
                projectedScore={
                  explain && explain.projectedDrs > explain.drsScore ? explain.projectedDrs : null
                }
              />
            </div>
          </Card>

          {/* decision charts: what's driving the score + owner-vs-business */}
          {explain && (
            <div className="eng-grid">
              <Card>
                <span className="stat-block-label">What's driving the score</span>
                <p className="muted" style={{ margin: '0.25rem 0 0.9rem' }}>
                  Each bar's width is the dimension's weight in the DRS; the fill is what it
                  contributes today. Biggest shortfall first.
                </p>
                <ContributionBars dimensions={explain.dimensions} />
              </Card>
              <Card>
                <span className="stat-block-label">Business vs. owner readiness</span>
                <p className="muted" style={{ margin: '0.25rem 0 0.9rem' }}>
                  The DRS and the Owner Readiness Index on one scale — their gap is a finding in
                  itself.
                </p>
                <DivergenceMeter drs={explain.drsScore} ori={explain.oriScore} />
              </Card>
            </div>
          )}

          {/* owner access + accounting connection */}
          <div className="eng-grid">
            <OwnerAccessCard engagementId={engagementId!} companyId={engagement.company_id} />
            <AccountingCard
              companyId={engagement.company_id}
              companyName={companyName}
              firmId={engagement.firm_id}
            />
          </div>
          {/* financial verification */}
          {latest && <VerificationCard assessmentId={latest.id} firmId={engagement.firm_id} />}

          {/* current snapshot + open gaps */}
          <div className="eng-grid">
            <Card>
              <div className="eng-snapshot-head">
                <span className="stat-block-label">Current readiness · assessment #{latest?.sequence_number}</span>
                {latest && (
                  <Link className="button-link" to={`/assessment/${latest.id}/results`}>
                    Full results →
                  </Link>
                )}
              </div>
              {explainQ.isLoading || !explain ? (
                <SkeletonLines lines={5} />
              ) : (
                <div className="eng-snapshot">
                  <div className="eng-snapshot-dial">
                    <ScoreDial value={explain.drsScore} tier={explain.drsTier} size={120} />
                    <TierBadge tier={explain.drsTier} />
                    <span className="muted" style={{ fontSize: '0.8rem' }}>ORI {fmtScore(explain.oriScore)}</span>
                    {verifQ.data && (
                      <span
                        className={`verif-chip verif-tier-${verifQ.data.tier === 'document_verified' ? 'high' : verifQ.data.tier === 'partly_verified' ? 'mid' : 'low'}`}
                        title="Share of financial inputs backed by documents or a connected ledger"
                      >
                        {verifQ.data.pct}% verified
                      </span>
                    )}
                  </div>
                  <div className="eng-snapshot-dims">
                    <DimensionBars dimensions={explain.dimensions.map((d) => ({ code: d.code, name: d.name, score: d.score }))} />
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <span className="stat-block-label">
                Open gaps to remediate{' '}
                {gapsQ.data && <span className="count-pill">{gapsQ.data.length}</span>}
              </span>
              <div style={{ marginTop: '0.9rem' }}>
                {gapsQ.isLoading ? (
                  <SkeletonLines lines={4} />
                ) : (gapsQ.data ?? []).length === 0 ? (
                  <p className="gap-none">No open gaps — a clean book.</p>
                ) : (
                  <ul className="eng-gap-list">
                    {(gapsQ.data ?? []).map((g) => (
                      <li key={g.id}>
                        <span className={`gap-chip gap-${g.severity === 'critical' ? 'critical' : g.severity === 'high' ? 'serious' : g.severity === 'med' ? 'warning' : 'neutral'}`}>
                          {g.severity}
                        </span>
                        <span className="eng-gap-text">
                          <strong>{g.name}</strong>
                          {g.playbookName && (
                            <span className="muted"> — {g.playbookName}: {g.playbookSummary}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {completed.length > 1 && (burndownQ.data ?? []).length > 1 && (
                <div className="eng-burndown">
                  <span className="stat-block-label">Open gaps over time</span>
                  <div style={{ marginTop: '0.6rem' }}>
                    <GapBurndown points={burndownQ.data ?? []} />
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* compare any two */}
          <ComparePanel assessments={completed} />
        </>
      ) : (
        <EmptyState
          title="No completed assessments yet"
          action={profile && !inProgress && <button onClick={startAssessment}>Start baseline assessment</button>}
        >
          The baseline assessment sets the starting DRS and opens this engagement’s trajectory.
        </EmptyState>
      )}

      {/* assessments list */}
      <h3 className="section-heading">Assessments</h3>
      <ul className="assessment-list">
        {assessments.map((a) => (
          <AssessmentCard key={a.id} a={a} />
        ))}
      </ul>

      {/* tasks (populated in F5) + documents */}
      <div className="eng-grid">
        <div>
          <h3 className="section-heading">Roadmap</h3>
          <EmptyState
            icon="◷"
            title="Remediation roadmap"
            action={
              <Link className="button-link" to={`/engagement/${engagementId}/roadmap`}>
                Open roadmap →
              </Link>
            }
          >
            Turn the open gaps — most critical first — into a sequenced task plan with a Gantt
            timeline, alongside the owner’s personal milestones.
          </EmptyState>
        </div>
        <div>
          <h3 className="section-heading">Documents</h3>
          {documents.length === 0 ? (
            <EmptyState icon="▤" title="No documents yet">
              Generate an owner report or a branded delta report from an assessment.
            </EmptyState>
          ) : (
            <ul className="assessment-list">
              {documents.map((d) => (
                <li key={d.id} className="assessment-card">
                  <span className="assessment-seq">{d.doc_type.replace('_', ' ')}</span>
                  <span className="assessment-score muted">
                    {d.finalized_at ? `finalized ${fmtDate(d.finalized_at)}` : 'draft'} · {fmtDate(d.created_at)}
                  </span>
                  <Link className="button-link" to={`/assessment/${d.assessment_id}/report`}>
                    Open →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ComparePanel({ assessments }: { assessments: AssessmentRow[] }) {
  const [priorId, setPriorId] = useState('');
  const [currentId, setCurrentId] = useState('');

  useEffect(() => {
    if (assessments.length >= 2) {
      setPriorId(assessments[assessments.length - 2].id);
      setCurrentId(assessments[assessments.length - 1].id);
    }
  }, [assessments]);

  const compareQ = useCompare(priorId || undefined, currentId || undefined);
  if (assessments.length < 2) return null;

  const label = (a: AssessmentRow) =>
    `#${a.sequence_number} · DRS ${fmtScore(Number(a.drs_score))} · ${a.completed_at ? fmtDate(a.completed_at) : ''}`;

  const cmp = compareQ.data;
  const dimCols: Column<{ code: string; prior: number; current: number; delta: number }>[] = [
    { key: 'code', header: 'Dimension' },
    { key: 'prior', header: 'Prior', numeric: true, render: (r) => fmtScore(r.prior) },
    { key: 'current', header: 'Current', numeric: true, render: (r) => fmtScore(r.current) },
    { key: 'delta', header: 'Δ', numeric: true, render: (r) => <DeltaChip value={r.delta} digits={2} /> },
  ];

  return (
    <>
      <h3 className="section-heading">Compare two assessments</h3>
      <Card>
        <div className="compare-controls">
          <label className="filter-control">
            <span className="filter-label">Prior</span>
            <select value={priorId} onChange={(e) => setPriorId(e.target.value)}>
              {assessments.map((a) => (
                <option key={a.id} value={a.id}>
                  {label(a)}
                </option>
              ))}
            </select>
          </label>
          <span className="compare-arrow" aria-hidden>→</span>
          <label className="filter-control">
            <span className="filter-label">Current</span>
            <select value={currentId} onChange={(e) => setCurrentId(e.target.value)}>
              {assessments.map((a) => (
                <option key={a.id} value={a.id}>
                  {label(a)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginTop: '1rem' }}>
          {priorId === currentId ? (
            <p className="muted">Pick two different assessments to see the change.</p>
          ) : compareQ.isLoading ? (
            <SkeletonLines lines={4} />
          ) : compareQ.error ? (
            <p className="form-error">{compareQ.error.message}</p>
          ) : cmp && !cmp.comparable ? (
            <div className="compare-incomparable">
              <strong>Not directly comparable.</strong> The methodology changed between these
              assessments ({cmp.prior_version} → {cmp.current_version}), so a numeric delta would be
              misleading.
            </div>
          ) : cmp && cmp.comparable ? (
            <div>
              <div className="compare-headline">
                <div>
                  <span className="stat-block-label">DRS</span>
                  <div className="compare-scoreline">
                    <span className="tnum">{fmtScore(cmp.prior.drsScore)}</span>
                    <span className="compare-arrow">→</span>
                    <span className="tnum" style={{ fontWeight: 800 }}>{fmtScore(cmp.current.drsScore)}</span>
                    <DeltaChip value={cmp.drsDelta} />
                  </div>
                </div>
                <div>
                  <span className="stat-block-label">Owner readiness</span>
                  <div className="compare-scoreline">
                    <span className="tnum">{fmtScore(cmp.prior.oriScore)}</span>
                    <span className="compare-arrow">→</span>
                    <span className="tnum" style={{ fontWeight: 800 }}>{fmtScore(cmp.current.oriScore)}</span>
                    <DeltaChip value={cmp.oriDelta} />
                  </div>
                </div>
              </div>

              <div className="compare-gap-summary">
                <span className="delta delta-up">▼ {cmp.gapsResolved.length} resolved</span>
                <span className="delta delta-down">▲ {cmp.gapsOpened.length} newly opened</span>
              </div>

              <div style={{ marginTop: '1rem' }}>
                <DataTable columns={dimCols} rows={cmp.dimensions} keyFor={(r) => r.code} />
              </div>
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}

function AssessmentCard({ a }: { a: AssessmentRow }) {
  return (
    <li className="assessment-card">
      <span className="assessment-seq">#{a.sequence_number}</span>
      {a.status === 'completed' ? (
        <>
          <span className="assessment-score">
            DRS <strong className="tnum">{fmtScore(Number(a.drs_score))}</strong>{' '}
            {a.drs_tier && <TierBadge tier={a.drs_tier} size="sm" />} · ORI{' '}
            <span className="tnum">{fmtScore(Number(a.ori_score))}</span>
          </span>
          <span className="muted">{a.completed_at ? fmtDate(a.completed_at) : ''}</span>
          <Link className="button-link" to={`/assessment/${a.id}/results`}>
            Results →
          </Link>
          <Link className="button-link" to={`/assessment/${a.id}/workbench`}>
            What-if →
          </Link>
        </>
      ) : (
        <>
          <span className="muted">in progress</span>
          <Link className="button-link" to={`/assessment/${a.id}/intake`}>
            Resume intake →
          </Link>
        </>
      )}
    </li>
  );
}
