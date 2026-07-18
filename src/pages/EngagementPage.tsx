import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { loadActiveRubricVersion } from '../lib/rubric';
import { supabase } from '../lib/supabase';
import { buildAlignment, type AlignmentLeg } from '../lib/alignment';
import { rollUpCapitals } from '../lib/practitioner';
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
  useValuation,
  useEngagementLog,
  type EngagementLogRow,
  useEngagementOutcome,
  useExplain,
  type AssessmentRow,
} from '../lib/queries';
import {
  Card,
  Collapsible,
  DataTable,
  DeltaChip,
  DimensionBars,
  EmptyState,
  EngagementNav,
  GapSeverityChip,
  PageHeader,
  SectionCard,
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
  const valuationQ = useValuation(engagementId);
  const logQ = useEngagementLog(engagementId);
  const [logKind, setLogKind] = useState<EngagementLogRow['kind']>('meeting');
  const [logDate, setLogDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [logTitle, setLogTitle] = useState('');
  const [logDetail, setLogDetail] = useState('');
  const [logGap, setLogGap] = useState('');

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

  // Catch-up: an engagement may have begun months before it was entered here.
  // Let the advisor set its real start date and target window so the timeline,
  // sprints, and exit-pace reflect reality.
  const saveEngagement = async (patch: Record<string, unknown>) => {
    const { error } = await supabase.from('engagements').update(patch).eq('id', engagementId!);
    if (error) {
      setError(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: qk.engagement(engagementId!) });
  };

  // Institutional memory: capture a meeting, decision, or the rationale behind a
  // recommendation — the "why", attached to the gap it explains where relevant.
  const addLogEntry = async (e: FormEvent) => {
    e.preventDefault();
    if (!engagement || !logTitle.trim()) return;
    const { error } = await supabase.from('engagement_log').insert([
      {
        firm_id: engagement.firm_id,
        engagement_id: engagementId,
        author_id: profile?.id ?? null,
        kind: logKind,
        occurred_on: logDate || new Date().toISOString().slice(0, 10),
        title: logTitle.trim(),
        detail: logDetail.trim() || null,
        gap_id: logGap || null,
      },
    ]);
    if (error) {
      setError(error.message);
      return;
    }
    setLogTitle('');
    setLogDetail('');
    setLogGap('');
    qc.invalidateQueries({ queryKey: qk.engagementLog(engagementId!) });
  };

  const removeLogEntry = async (id: string) => {
    await supabase.from('engagement_log').delete().eq('id', id);
    qc.invalidateQueries({ queryKey: qk.engagementLog(engagementId!) });
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
    <div className="stack-lg">
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
          !inProgress && profile ? (
            <button onClick={startAssessment}>
              {assessments.length === 0 ? 'Start baseline assessment' : 'Start re-assessment'}
            </button>
          ) : (
            inProgress && (
              <Link className="button-link" to={`/assessment/${inProgress.id}/intake`}>
                Resume intake →
              </Link>
            )
          )
        }
      />
      <EngagementNav engagementId={engagementId!} />
      {error && <p className="form-error">{error}</p>}

      {completed.length > 0 ? (
        <>
          {/* readiness at a glance — the first thing an advisor needs: snapshot + gaps */}
          <div className="eng-grid eng-grid-top">
            <SectionCard
              title={`Current readiness · assessment #${latest?.sequence_number}`}
              action={
                latest && (
                  <Link className="button-link" to={`/assessment/${latest.id}/results`}>
                    Full results →
                  </Link>
                )
              }
            >
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
            </SectionCard>

            <SectionCard
              title={
                <>
                  Open gaps to remediate{' '}
                  {gapsQ.data && <span className="count-pill">{gapsQ.data.length}</span>}
                </>
              }
            >
              <div>
                {gapsQ.isLoading ? (
                  <SkeletonLines lines={4} />
                ) : (gapsQ.data ?? []).length === 0 ? (
                  <p className="gap-none">No open gaps — a clean book.</p>
                ) : (
                  <ul className="eng-gap-list">
                    {(gapsQ.data ?? []).map((g) => (
                      <li key={g.id}>
                        <GapSeverityChip severity={g.severity} />
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
                  <Collapsible title="Open gaps over time">
                    <GapBurndown points={burndownQ.data ?? []} />
                  </Collapsible>
                </div>
              )}
            </SectionCard>
          </div>

          {/* three legs of the stool — the CEPA alignment frame (docs/18) */}
          {explain && (() => {
            const v = valuationQ.data;
            const alignment = buildAlignment({
              drs: explain.drsScore,
              tier: explain.drsTier,
              ori: explain.oriScore,
              hasValuation: !!v?.has_recast,
              wealthGap: v?.wealth_gap ?? null,
              netProceeds: v?.net_proceeds ?? null,
              ownerWealthTarget: v?.owner_wealth_target ?? null,
              openGapCodes: (gapsQ.data ?? []).map((g) => g.code),
            });
            const bandLabel: Record<AlignmentLeg['band'], string> = {
              strong: 'On track', building: 'Building', attention: 'Needs work', unknown: 'Not sized',
            };
            return (
              <Card>
                <div className="legs-head">
                  <div>
                    <h3 className="legs-title">Three legs of the stool</h3>
                    <p className="legs-sub">Business, personal, and financial readiness have to balance for a clean exit — a short leg wobbles the whole plan.</p>
                  </div>
                  <span className={`legs-gate legs-gate-${alignment.gate.toLowerCase()}`} title={alignment.gateHint}>
                    {alignment.gate} gate
                  </span>
                </div>
                <div className="legs-grid">
                  {alignment.legs.map((l) => (
                    <div key={l.key} data-leg={l.key} className={`leg leg-${l.band}`}>
                      <div className="leg-top">
                        <span className="leg-label">{l.label}</span>
                        <span className={`leg-chip leg-chip-${l.band}`}>{bandLabel[l.band]}</span>
                      </div>
                      <div className="leg-headline">{l.headline}</div>
                      <p className="leg-detail">{l.detail}</p>
                      {l.key === 'financial' && l.band === 'unknown' && (
                        <Link className="leg-cta" to={`/engagement/${engagementId}/valuation`}>
                          Size it in Valuation →
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
                <p className={`legs-verdict${alignment.balanced ? '' : ' legs-verdict-alert'}`}>
                  {alignment.verdict}
                </p>
              </Card>
            );
          })()}

          {/* trajectory against the exit window */}
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

          {/* score detail — analytical depth, folded away so the default view stays simple */}
          {explain && (
            <Collapsible
              title="Score detail"
              hint="What's driving the DRS · business vs. owner readiness"
            >
              <div className="eng-grid" style={{ marginTop: 0 }}>
                <SectionCard
                  title="What's driving the score"
                  subtitle="Each bar's width is the dimension's weight in the DRS; the fill is what it contributes today. Biggest shortfall first."
                >
                  <ContributionBars dimensions={explain.dimensions} />
                </SectionCard>
                <SectionCard
                  title="Business vs. owner readiness"
                  subtitle="The DRS and the Owner Readiness Index on one scale — their gap is a finding in itself."
                >
                  <DivergenceMeter drs={explain.drsScore} ori={explain.oriScore} />
                </SectionCard>
              </div>
              <div className="capitals-lens">
                <p className="capitals-head">
                  Four intangible capitals{' '}
                  <span className="muted">— the CEPA lens: where the transferable value lives</span>
                </p>
                <div className="capitals-grid">
                  {rollUpCapitals(explain.dimensions).map((c) => (
                    <div key={c.key} className="capital">
                      <div className="capital-top">
                        <span className="capital-label">{c.label}</span>
                        <span className="capital-score">{c.score != null ? Math.round(c.score) : '—'}</span>
                      </div>
                      <p className="capital-blurb">{c.blurb}</p>
                    </div>
                  ))}
                </div>
              </div>
            </Collapsible>
          )}

          {/* engagement log — institutional memory: meetings, decisions, rationale */}
          <Collapsible
            title={
              <>
                Engagement log{' '}
                {logQ.data && logQ.data.length > 0 && (
                  <span className="count-pill">{logQ.data.length}</span>
                )}
              </>
            }
            hint="Meetings, decisions & the rationale behind recommendations"
          >
            <div className="stack-lg">
              <ul className="log-list">
                {(logQ.data ?? []).length === 0 && (
                  <p className="muted" style={{ margin: 0 }}>
                    No entries yet — record a meeting or the reasoning behind a recommendation so it
                    compounds into the firm’s knowledge, not one advisor’s memory.
                  </p>
                )}
                {(logQ.data ?? []).map((entry) => {
                  const gap = (gapsQ.data ?? []).find((g) => g.id === entry.gap_id);
                  return (
                    <li key={entry.id} className="log-entry">
                      <span className={`log-kind log-kind-${entry.kind}`}>{entry.kind}</span>
                      <div className="log-body">
                        <div className="log-head">
                          <strong>{entry.title}</strong>
                          <span className="muted log-date">{fmtDate(entry.occurred_on)}</span>
                        </div>
                        {entry.detail && <p className="log-detail">{entry.detail}</p>}
                        {gap && <span className="log-gap">re: {gap.name}</span>}
                      </div>
                      <button className="linkish" onClick={() => removeLogEntry(entry.id)}>
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
              <form className="inline-form log-form" onSubmit={addLogEntry}>
                <h3>Add to the log</h3>
                <div className="log-form-row">
                  <select value={logKind} onChange={(e) => setLogKind(e.target.value as EngagementLogRow['kind'])}>
                    <option value="meeting">Meeting</option>
                    <option value="decision">Decision</option>
                    <option value="rationale">Rationale</option>
                    <option value="note">Note</option>
                  </select>
                  <input type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} />
                  <select value={logGap} onChange={(e) => setLogGap(e.target.value)}>
                    <option value="">Not tied to a gap</option>
                    {(gapsQ.data ?? []).map((g) => (
                      <option key={g.id} value={g.id}>
                        re: {g.name}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  placeholder="e.g. Q2 review — agreed to prioritize customer diversification"
                  value={logTitle}
                  onChange={(e) => setLogTitle(e.target.value)}
                  required
                />
                <textarea
                  placeholder="Detail / rationale (why this decision or recommendation)"
                  value={logDetail}
                  onChange={(e) => setLogDetail(e.target.value)}
                  rows={2}
                />
                <button type="submit">Add entry</button>
              </form>
            </div>
          </Collapsible>

          {/* compare any two — power tool, folded away */}
          {completed.length > 1 && (
            <Collapsible title="Compare two assessments" hint="See what changed between any two">
              <ComparePanel assessments={completed} embedded />
            </Collapsible>
          )}

          {/* setup & admin — connections and record-keeping, folded away by default */}
          <Collapsible
            title="Engagement setup & admin"
            hint="Owner access · accounting · verification"
          >
            <div className="stack-lg">
              <SectionCard
                title="Engagement timeline"
                subtitle="Started working with this owner before now? Set the real start date and target window so the trajectory, sprints, and exit pace match the actual engagement."
              >
                <div className="eng-timeline-form">
                  <label>
                    Started
                    <input
                      type="date"
                      defaultValue={engagement.started_at ? engagement.started_at.slice(0, 10) : ''}
                      max={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => e.target.value && saveEngagement({ started_at: e.target.value })}
                    />
                  </label>
                  <label>
                    Target exit window
                    <select
                      defaultValue={engagement.target_exit_window ?? ''}
                      onChange={(e) => saveEngagement({ target_exit_window: e.target.value || null })}
                    >
                      <option value="">Not set</option>
                      <option value="under 12 months">Under 12 months</option>
                      <option value="12-24 months">12–24 months</option>
                      <option value="24-36 months">24–36 months</option>
                      <option value="36+ months">36+ months</option>
                    </select>
                  </label>
                </div>
              </SectionCard>
              <div className="eng-grid" style={{ marginTop: 0 }}>
                <OwnerAccessCard engagementId={engagementId!} companyId={engagement.company_id} />
                <AccountingCard
                  companyId={engagement.company_id}
                  companyName={companyName}
                  firmId={engagement.firm_id}
                />
              </div>
              {latest && <VerificationCard assessmentId={latest.id} firmId={engagement.firm_id} />}
            </div>
          </Collapsible>
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
      <section>
        <h3 className="section-heading">Assessments</h3>
        <ul className="assessment-list">
          {assessments.map((a) => (
            <AssessmentCard key={a.id} a={a} />
          ))}
        </ul>
      </section>

      {/* documents generated from this engagement */}
      <section>
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
      </section>
    </div>
  );
}

function ComparePanel({ assessments, embedded = false }: { assessments: AssessmentRow[]; embedded?: boolean }) {
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

  const inner = (
    <>
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
    </>
  );

  if (embedded) return inner;
  return (
    <section>
      <h3 className="section-heading">Compare two assessments</h3>
      <Card>{inner}</Card>
    </section>
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
