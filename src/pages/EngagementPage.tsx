import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { loadActiveRubricVersion } from '../lib/rubric';
import { invokeFunction, supabase } from '../lib/supabase';
import { documentType } from '../../shared/documents/catalog';
import { useAsyncAction } from '../lib/useAsyncAction';
import { buildEngagementKnowledge } from '../lib/knowledge';
import { buildWorkstreamProgress } from '../lib/workstreams';
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
  useTasks,
  useComparables,
  useDealOutcome,
  useEngagementOutcome,
  useExplain,
  type AssessmentRow,
} from '../lib/queries';
import {
  Card,
  Collapsible,
  ConfirmDialog,
  DataTable,
  DeltaChip,
  DimensionBars,
  EmptyState,
  ErrorState,
  EngagementNav,
  WorkstreamRail,
  GapSeverityChip,
  PageHeader,
  PageSection,
  SectionCard,
  ScoreDial,
  SkeletonLines,
  SubTabs,
  TierBadge,
  ExitPaceChart,
  ContributionBars,
  DivergenceMeter,
  GapBurndown,
  useToast,
  type Column,
  type PacePoint,
  type SubTab,
} from '../components/ui';
import { VerificationCard } from '../components/VerificationCard';
import { EngagementTeamCard } from '../components/EngagementTeamCard';
import { EngagementComments } from '../components/EngagementComments';
import { EngagementProfessionalsCard } from '../components/EngagementProfessionalsCard';
import { fmtDate, fmtScore, humanizeKey } from '../lib/format';

// Methodology target: "Competitive Process Ready" at DRS 85 (docs/07). Shown as
// the aspiration line on the trajectory.
const TARGET_DRS = 85;

// The overview shows a preview of the open gaps, not the full list; the Buyer
// lens tab is the place to work the complete set. Cap the snapshot so the block
// stays a glanceable summary next to Current readiness.
const GAP_PREVIEW = 5;

// The concrete date the readiness plan runs to. Prefer the advisor-set target
// close date (set on the Roadmap or the Setup tab); otherwise fall back to the
// coarse target-exit window ("24-36 months" → engagement start + the earliest
// month in the window, the "ready by" date), defaulting to 24 months when the
// window is missing or unparseable.
function targetExitDate(startedAt: string, window: string | null, closeDate?: string | null): Date {
  if (closeDate) return new Date(closeDate);
  const months = Number(window?.match(/\d+/)?.[0] ?? 24);
  const d = new Date(startedAt);
  d.setMonth(d.getMonth() + (Number.isFinite(months) ? months : 24));
  return d;
}

// The engagement lifecycle states (engagement_status enum). `active` and
// `paused` are working states; `exited` and `churned` are terminal — the deal
// closed, or the client left before one. Managed on the Setup & admin tab.
type EngagementStatus = 'active' | 'paused' | 'exited' | 'churned';
const STATUS_LABEL: Record<EngagementStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  exited: 'Exited — deal closed',
  churned: 'Churned — left before exit',
};

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
  const tasksQ = useTasks(engagementId);
  const comparablesQ = useComparables(engagementId);
  const [logKind, setLogKind] = useState<EngagementLogRow['kind']>('meeting');
  const [logDate, setLogDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [logTitle, setLogTitle] = useState('');
  const [logDetail, setLogDetail] = useState('');
  const [logGap, setLogGap] = useState('');
  const [analysisTab, setAnalysisTab] = useState('score');

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

      // Carry forward: a re-assessment starts from the last scored assessment's
      // answers so the advisor updates what changed instead of re-entering the
      // whole rubric each quarter (docs/archive/34 C1). Only when the prior assessment
      // used the same rubric version — a new methodology changes the question
      // set, so it must start blank. This creates a NEW immutable assessment
      // seeded with a draft; it never edits the prior one (CLAUDE.md rule 4).
      // Provenance is intentionally NOT copied: a carried figure is a draft, not
      // a re-verified fact, so it reverts to self-reported until re-checked.
      // A copy hiccup must never block starting the assessment.
      if (latest && latest.rubric_version_id === rubricVersion.id) {
        try {
          const { data: prior } = await supabase
            .from('answers')
            .select('question_id, value')
            .eq('assessment_id', latest.id);
          if (prior && prior.length > 0) {
            await supabase.from('answers').insert(
              prior.map((p) => ({
                assessment_id: data.id,
                question_id: p.question_id,
                value: p.value,
                answered_by: profile?.id ?? null,
              })),
            );
          }
        } catch {
          /* start blank rather than fail the whole action */
        }
      }

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
  if (!engagement) return <ErrorState variant="section" error={engagementQ.error ?? 'Engagement not found'} onRetry={() => void engagementQ.refetch()} />;

  const companyName = companyQ.data?.name ?? '';
  const inProgress = assessments.find((a) => a.status === 'in_progress');
  const pacePoints: PacePoint[] = completed
    .filter((a) => a.completed_at)
    .map((a) => ({
      date: a.completed_at as string,
      score: Number(a.drs_score),
      tier: a.drs_tier ?? undefined,
    }));
  const exitDate = targetExitDate(engagement.started_at, engagement.target_exit_window, engagement.target_close_date);
  const delta =
    completed.length > 1
      ? Number(completed[completed.length - 1].drs_score) - Number(completed[0].drs_score)
      : null;
  const explain = explainQ.data;
  const outcomeStatus = outcomeQ.data?.process_status ?? null;
  const documents = documentsQ.data ?? [];

  // The five work streams as a progress rail (docs/17 follow-up; docs/archive/22): where
  // the engagement stands in each core workflow, from the data already loaded.
  const workstreams = buildWorkstreamProgress({
    assessed: completed.length > 0,
    inProgress: !!inProgress,
    drsScore: latest?.drs_score != null ? Number(latest.drs_score) : null,
    openGapCount: gapsQ.data?.length ?? 0,
    tasksTotal: tasksQ.data?.length ?? 0,
    tasksDone: (tasksQ.data ?? []).filter((t) => t.status === 'done').length,
    verifiedPct: verifQ.data?.pct ?? null,
    valuationSet: !!valuationQ.data?.has_recast,
    valueGap: valuationQ.data?.value_creation_gap ?? null,
    reportDraftCount: documents.filter((d) => !d.finalized_at).length,
    reportFinalCount: documents.filter((d) => d.finalized_at).length,
  });

  // Deeper analysis lives in a single sub-tabbed panel rather than a deep stack
  // of collapsibles (docs/archive/22 F4): one view at a time, chosen deliberately. The
  // tabs are built from what this engagement actually has.
  const analysisTabs: SubTab[] = [];
  if (explain) analysisTabs.push({ key: 'score', label: 'Score detail' });
  analysisTabs.push({
    key: 'log',
    label: 'Engagement log',
    badge: (logQ.data?.length ?? 0) || undefined,
  });
  if ((gapsQ.data ?? []).length > 0)
    analysisTabs.push({ key: 'connections', label: 'How the plan connects' });
  analysisTabs.push({ key: 'outcome', label: 'Deal outcome' });
  if ((comparablesQ.data ?? []).length > 0)
    analysisTabs.push({ key: 'comparables', label: 'Comparables', badge: comparablesQ.data!.length });
  if (completed.length > 1) analysisTabs.push({ key: 'compare', label: 'Compare' });
  analysisTabs.push({ key: 'setup', label: 'Setup & admin' });
  const activeAnalysis = analysisTabs.some((t) => t.key === analysisTab)
    ? analysisTab
    : (analysisTabs[0]?.key ?? 'log');

  // Engagement management (timeline/status + hard delete). Extracted so it renders
  // BOTH inside the Setup & admin analysis tab and, crucially, when the engagement
  // has no completed assessment yet — otherwise a mis-created engagement (the exact
  // case you'd want to delete) had no reachable delete/status control at all.
  const setupAdmin = (
    <div className="stack-lg">
      <SectionCard
        title="Engagement timeline & status"
        subtitle="Set the actual start date and target window so the trajectory, sprints, and exit pace reflect the real engagement, and move the engagement through its lifecycle."
      >
        <div className="eng-timeline-form">
          <label>
            Status
            <select
              value={engagement.status}
              onChange={(e) => saveEngagement({ status: e.target.value })}
            >
              {(Object.keys(STATUS_LABEL) as EngagementStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
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
          <label>
            Target sale date
            <input
              type="date"
              defaultValue={engagement.target_close_date ? engagement.target_close_date.slice(0, 10) : ''}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => saveEngagement({ target_close_date: e.target.value || null })}
            />
          </label>
        </div>
        <p className="muted text-sm" style={{ margin: '0.5rem 0 0' }}>
          Paused keeps the record but signals no active work; Exited and Churned are terminal.
          To remove the engagement entirely, use “Delete engagement” below.
        </p>
      </SectionCard>
      <EngagementTeamCard engagementId={engagementId!} companyId={engagement.company_id} />
      <EngagementComments engagementId={engagementId!} />
      <EngagementProfessionalsCard engagementId={engagementId!} firmId={engagement.firm_id} />
      {latest && <VerificationCard assessmentId={latest.id} firmId={engagement.firm_id} />}
      <ExportEngagementCard engagementId={engagementId!} companyName={companyName} />
      <DeleteEngagementCard
        engagementId={engagementId!}
        companyName={companyName}
        counts={{
          assessments: assessments.length,
          documents: documents.length,
          gaps: gapsQ.data?.length ?? 0,
          tasks: tasksQ.data?.length ?? 0,
          logEntries: logQ.data?.length ?? 0,
          hasValuation: !!valuationQ.data?.has_recast,
          hasDealOutcome: !!outcomeStatus,
        }}
      />
    </div>
  );

  return (
    <div className="page-shell">
      <header className="page-masthead">
      <PageHeader
        title={companyName}
        crumbs={[{ label: 'Engagements', to: '/' }, { label: companyName }]}
        subtitle={
          <>
            {STATUS_LABEL[engagement.status as EngagementStatus] ?? engagement.status}
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
      </header>
      {error && <ErrorState variant="inline" error={error} />}

      {completed.length > 0 ? (
        <>
          <section className="page-section">
          <div className="stack-lg">
          {/* work-stream progress rail — where the engagement stands across the five
              core workflows, and the way into each (docs/17 follow-up; docs/archive/22) */}
          <WorkstreamRail streams={workstreams} engagementId={engagementId!} />

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
                    <span className="muted text-sm">ORI {fmtScore(explain.oriScore)}</span>
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
              action={
                <Link className="button-link" to={`/engagement/${engagementId}/buyer-lens`}>
                  Buyer lens →
                </Link>
              }
            >
              <div>
                {gapsQ.isLoading ? (
                  <SkeletonLines lines={4} />
                ) : (gapsQ.data ?? []).length === 0 ? (
                  <p className="gap-none">No open gaps.</p>
                ) : (
                  <>
                    <ul className="eng-gap-list">
                      {(gapsQ.data ?? []).slice(0, GAP_PREVIEW).map((g) => (
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
                    {(gapsQ.data ?? []).length > GAP_PREVIEW && (
                      <Link className="eng-gap-more" to={`/engagement/${engagementId}/buyer-lens`}>
                        +{(gapsQ.data ?? []).length - GAP_PREVIEW} more in the Buyer lens →
                      </Link>
                    )}
                  </>
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
          </div>
          </section>

          <PageSection title="Analysis & detail" note="Deeper analysis — pick a view">
          <SubTabs
            tabs={analysisTabs}
            activeKey={activeAnalysis}
            ariaLabel="Analysis sections"
            onSelect={setAnalysisTab}
          />
          <div className="subtabs-panel stack-lg" style={{ gap: 'var(--space-3)' }}>
          {/* score detail — analytical depth */}
          {activeAnalysis === 'score' && explain && (
            <div className="eng-grid" style={{ marginTop: 0 }}>
              <SectionCard
                title="What's driving the score"
                subtitle="Each bar's width is the dimension's weight in the DRS; the fill is what it contributes today. Biggest shortfall first."
              >
                <ContributionBars dimensions={explain.dimensions} />
              </SectionCard>
              <SectionCard
                title="Business vs. owner readiness"
                subtitle="The DRS and Owner Readiness Index on one scale; the gap between them is itself a finding."
              >
                <DivergenceMeter drs={explain.drsScore} ori={explain.oriScore} />
              </SectionCard>
            </div>
          )}

          {/* engagement log — institutional memory: meetings, decisions, rationale */}
          {activeAnalysis === 'log' && (
            <div className="stack-lg">
              <ul className="log-list">
                {(logQ.data ?? []).length === 0 && (
                  <p className="muted m-0">
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
          )}

          {/* how the plan connects — the engagement knowledge chain */}
          {activeAnalysis === 'connections' && (gapsQ.data ?? []).length > 0 && (() => {
            const knowledge = buildEngagementKnowledge({
              gaps: (gapsQ.data ?? []).map((g) => ({
                id: g.id, name: g.name, severity: g.severity, status: g.status, playbookName: g.playbookName,
              })),
              tasks: (tasksQ.data ?? []).map((t) => ({ gap_id: t.gap_id, status: t.status })),
              log: (logQ.data ?? []).map((l) => ({
                id: l.id, kind: l.kind, title: l.title, occurred_on: l.occurred_on, gap_id: l.gap_id,
              })),
            });
            return (
              <>
                <p className="muted mt-0">
                  The engagement's connected record: {knowledge.connectedPct}% of logged reasoning is tied to a
                  specific recommendation.
                </p>
                <ul className="chain-list">
                  {knowledge.chains.map((c) => (
                    <li key={c.gapId} className="chain">
                      <div className="chain-head">
                        <GapSeverityChip severity={c.severity} />
                        <strong>{c.gapName}</strong>
                        {c.status !== 'open' && <span className="chain-status">{c.status}</span>}
                        <span className="chain-progress muted">
                          {c.total > 0 ? `${c.done}/${c.total} tasks` : 'no tasks yet'}
                        </span>
                      </div>
                      <div className="chain-flow">
                        <span className="chain-node">Risk</span>
                        <span className="chain-arrow">→</span>
                        <span className={`chain-node ${c.recommendation ? '' : 'chain-node-missing'}`}>
                          {c.recommendation ?? 'no recommendation'}
                        </span>
                        <span className="chain-arrow">→</span>
                        <span className={`chain-node ${c.reasoning.length ? '' : 'chain-node-missing'}`}>
                          {c.reasoning.length ? `${c.reasoning.length} rationale` : 'no rationale logged'}
                        </span>
                      </div>
                      {c.reasoning.map((r) => (
                        <div key={r.id} className="chain-reason">
                          <span className={`log-kind log-kind-${r.kind}`}>{r.kind}</span>
                          {r.title} <span className="muted">· {fmtDate(r.occurred_on)}</span>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              </>
            );
          })()}

          {/* deal outcome — record what actually happened (calibration substrate) */}
          {activeAnalysis === 'outcome' && (
            <DealOutcomeCapture
              engagementId={engagementId!}
              firmId={engagement.firm_id}
              gaps={(gapsQ.data ?? []).map((g) => ({ code: g.code, name: g.name }))}
            />
          )}

          {/* comparable engagements — learn from the firm's own book */}
          {activeAnalysis === 'comparables' && (comparablesQ.data ?? []).length > 0 && (
              <ul className="cmp-list">
                {comparablesQ.data!.map((c) => (
                  <li key={c.engagementId} className="cmp">
                    <Link className="cmp-name" to={`/engagement/${c.engagementId}`}>
                      {c.companyName}
                    </Link>
                    <span className="cmp-meta">
                      {c.tier ? <TierBadge tier={c.tier} /> : <span className="muted">not yet scored</span>}
                      {c.outcomeStatus && <span className="cmp-outcome">{humanizeKey(c.outcomeStatus)}</span>}
                    </span>
                    <span className="cmp-reasons muted">{c.reasons.join(' · ')}</span>
                  </li>
                ))}
              </ul>
          )}

          {/* compare any two — power tool */}
          {activeAnalysis === 'compare' && completed.length > 1 && (
              <ComparePanel assessments={completed} embedded />
          )}

          {/* setup & admin — connections and record-keeping */}
          {activeAnalysis === 'setup' && setupAdmin}
          </div>
          </PageSection>
        </>
      ) : (
        <>
          <EmptyState
            title="No completed assessments yet"
            action={profile && !inProgress && <button onClick={startAssessment}>Start baseline assessment</button>}
          >
            The baseline assessment sets the starting DRS and opens this engagement’s trajectory.
          </EmptyState>
          {/* Management stays reachable before the first assessment — otherwise a
              mis-created engagement can never be renamed, paused, or deleted. */}
          <PageSection title="Setup & admin" note="Timeline, status, and deletion">
            {setupAdmin}
          </PageSection>
        </>
      )}

      <PageSection title="Record" note="Assessment history & documents">
      <div className="stack-lg">
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
          <EmptyState
            icon="documents"
            title="No documents yet"
            action={
              latest && (
                <Link
                  className="button-link button-primary"
                  to={`/engagement/${engagementId}/deliverables/owner?assessment=${latest.id}`}
                >
                  Generate the owner report →
                </Link>
              )
            }
          >
            Generate an owner report or a branded delta report from an assessment.
          </EmptyState>
        ) : (
          <ul className="assessment-list">
            {documents.map((d) => (
              <li key={d.id} className="assessment-card">
                <span className="assessment-seq">{humanizeKey(d.doc_type)}</span>
                <span className="assessment-score muted">
                  {d.finalized_at ? `finalized ${fmtDate(d.finalized_at)}` : 'draft'} · {fmtDate(d.created_at)}
                </span>
                <Link
                  className="button-link"
                  to={`/engagement/${engagementId}/deliverables/${documentType(d.doc_type)?.section ?? 'owner'}?assessment=${d.assessment_id}`}
                >
                  Open →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>
      </PageSection>
    </div>
  );
}

// Deal-outcome capture (moat #1): record what actually happened at close. The
// record-deal-outcome function snapshots the prediction (DRS/EV) automatically;
// here the advisor captures the facts — including which gaps the buyer flagged,
// the highest-value calibration signal. Capture only (no predicted-vs-actual
// comparison surface, which was removed by product direction).
const OUTCOMES = [
  { v: 'closed', l: 'Closed' },
  { v: 'broken', l: 'Broken' },
  { v: 'withdrawn', l: 'Withdrawn' },
] as const;
const BUYER_TYPES = ['strategic', 'financial', 'individual', 'management', 'other'];
const STRUCTURES = ['all_cash', 'cash_and_note', 'earnout', 'equity_rollover', 'other'];

function DealOutcomeCapture({
  engagementId,
  firmId,
  gaps,
}: {
  engagementId: string;
  firmId: string;
  gaps: { code: string; name: string }[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const outcomeQ = useDealOutcome(engagementId);
  const existing = outcomeQ.data;
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    outcome: 'closed',
    close_date: '',
    days_on_market: '',
    final_ev: '',
    final_multiple: '',
    ebitda_at_close: '',
    buyer_type: '',
    structure: '',
    retrade: false,
    retrade_pct: '',
    notes: '',
  });
  const [risks, setRisks] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!existing) return;
    setF({
      outcome: existing.outcome,
      close_date: existing.close_date ?? '',
      days_on_market: existing.days_on_market?.toString() ?? '',
      final_ev: existing.final_ev?.toString() ?? '',
      final_multiple: existing.final_multiple?.toString() ?? '',
      ebitda_at_close: existing.ebitda_at_close?.toString() ?? '',
      buyer_type: existing.buyer_type ?? '',
      structure: existing.structure ?? '',
      retrade: existing.retrade ?? false,
      retrade_pct: existing.retrade_pct?.toString() ?? '',
      notes: existing.notes ?? '',
    });
    setRisks(new Set(existing.buyer_flagged_risks ?? []));
  }, [existing]);

  const set = (k: keyof typeof f, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));
  const toggleRisk = (code: string) =>
    setRisks((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await invokeFunction('record-deal-outcome', {
        engagement_id: engagementId,
        input: {
          outcome: f.outcome,
          close_date: f.close_date || null,
          days_on_market: f.days_on_market === '' ? null : Number(f.days_on_market),
          final_ev: f.final_ev === '' ? null : Number(f.final_ev),
          final_multiple: f.final_multiple === '' ? null : Number(f.final_multiple),
          ebitda_at_close: f.ebitda_at_close === '' ? null : Number(f.ebitda_at_close),
          buyer_type: f.buyer_type || null,
          structure: f.structure || null,
          retrade: f.retrade,
          retrade_pct: f.retrade_pct === '' ? null : Number(f.retrade_pct),
          buyer_flagged_risks: [...risks],
          notes: f.notes.trim() || null,
          recorded_by: profile?.id ?? null,
        },
      });
      // Keep the engagement's process status in step with the recorded outcome.
      await supabase
        .from('engagement_outcomes')
        .upsert({ firm_id: firmId, engagement_id: engagementId, process_status: f.outcome }, { onConflict: 'engagement_id' });
      qc.invalidateQueries({ queryKey: ['dealOutcome', engagementId] });
      qc.invalidateQueries({ queryKey: qk.engagementOutcome(engagementId) });
      toast.show('Outcome recorded', 'good');
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setBusy(false);
  };

  return (
    <form className="outcome-form stack-lg" onSubmit={save}>
      <p className="muted m-0">
        {existing
          ? 'Outcome recorded. Update any field and save again.'
          : 'Record the result at close or break. The score/valuation prediction at this moment is snapshotted automatically to calibrate future scores.'}
      </p>
      <div className="outcome-grid">
        <label>Outcome
          <select value={f.outcome} onChange={(e) => set('outcome', e.target.value)}>
            {OUTCOMES.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </label>
        <label>Close / break date
          <input type="date" value={f.close_date} onChange={(e) => set('close_date', e.target.value)} />
        </label>
        <label>Days on market
          <input type="number" value={f.days_on_market} onChange={(e) => set('days_on_market', e.target.value)} />
        </label>
        <label>Final EV ($)
          <input type="number" value={f.final_ev} onChange={(e) => set('final_ev', e.target.value)} />
        </label>
        <label>Final multiple (x)
          <input type="number" step="0.1" value={f.final_multiple} onChange={(e) => set('final_multiple', e.target.value)} />
        </label>
        <label>EBITDA at close ($)
          <input type="number" value={f.ebitda_at_close} onChange={(e) => set('ebitda_at_close', e.target.value)} />
        </label>
        <label>Buyer type
          <select value={f.buyer_type} onChange={(e) => set('buyer_type', e.target.value)}>
            <option value="">—</option>
            {BUYER_TYPES.map((b) => <option key={b} value={b}>{humanizeKey(b)}</option>)}
          </select>
        </label>
        <label>Structure
          <select value={f.structure} onChange={(e) => set('structure', e.target.value)}>
            <option value="">—</option>
            {STRUCTURES.map((s) => <option key={s} value={s}>{humanizeKey(s)}</option>)}
          </select>
        </label>
        <label className="outcome-retrade">
          <input type="checkbox" checked={f.retrade} onChange={(e) => set('retrade', e.target.checked)} /> Retrade
        </label>
        {f.retrade && (
          <label>Retrade (%)
            <input type="number" step="0.1" value={f.retrade_pct} onChange={(e) => set('retrade_pct', e.target.value)} />
          </label>
        )}
      </div>
      {gaps.length > 0 && (
        <div>
          <span className="outcome-risks-label">Which gaps did the buyer actually flag?</span>
          <div className="outcome-risks">
            {gaps.map((g) => (
              <label key={g.code} className={`outcome-risk ${risks.has(g.code) ? 'on' : ''}`}>
                <input type="checkbox" checked={risks.has(g.code)} onChange={() => toggleRisk(g.code)} /> {g.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <textarea placeholder="Notes (what drove the price, terms, lessons)" value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />
      <div>
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : existing ? 'Update outcome' : 'Record outcome'}</button>
        {existing?.updated_at && <span className="muted" style={{ marginLeft: '0.6rem' }}>last saved {fmtDate(existing.updated_at)}</span>}
      </div>
    </form>
  );
}

// Self-serve data export (docs/archive/35 Phase 9): download a full, portable JSON copy
// of the engagement's data — the read-only counterpart to Delete. Backs a client's
// "give us our data" request, a backup before deletion, or a migration.
function ExportEngagementCard({ engagementId, companyName }: { engagementId: string; companyName: string }) {
  const { busy, run } = useAsyncAction();

  const download = () =>
    run(
      async () => {
        const data = await invokeFunction<Record<string, unknown>>('export-engagement', {
          engagement_id: engagementId,
        });
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const slug = companyName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'engagement';
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `exitblueprint-${slug}-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
      { success: 'Export downloaded' },
    );

  return (
    <SectionCard title="Export data" subtitle="Download a full copy of this engagement's data.">
      <div className="danger-zone">
        <div>
          <strong>Export this engagement</strong>
          <p className="muted text-sm m-0">
            A portable JSON file with the assessments and scores, gaps, roadmap, valuation, data room,
            outcomes, engagement log, and generated report text. Uploaded document files are listed but
            not included. Nothing is changed or removed.
          </p>
        </div>
        <button onClick={download} disabled={busy}>
          {busy ? 'Preparing…' : 'Export data (JSON)'}
        </button>
      </div>
    </SectionCard>
  );
}

// The destructive escape hatch: permanently remove an engagement and everything
// under it. The soft path (pause / mark exited or churned) lives in the status
// control above; this is for undoing a mis-created engagement or honouring a
// "delete our data" request. Gated behind a typed confirmation — the advisor
// must retype the company name — and it spells out exactly what is destroyed,
// because none of it can be recovered.
function DeleteEngagementCard({
  engagementId,
  companyName,
  counts,
}: {
  engagementId: string;
  companyName: string;
  counts: {
    assessments: number;
    documents: number;
    gaps: number;
    tasks: number;
    logEntries: number;
    hasValuation: boolean;
    hasDealOutcome: boolean;
  };
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = confirmText.trim().toLowerCase() === companyName.trim().toLowerCase();

  // What will be destroyed, phrased plainly. Only lines that actually apply are
  // shown so the warning is concrete, not boilerplate.
  const willLose: string[] = [];
  if (counts.assessments > 0)
    willLose.push(`${counts.assessments} assessment${counts.assessments === 1 ? '' : 's'} and their full score history`);
  if (counts.gaps > 0) willLose.push(`${counts.gaps} tracked gap${counts.gaps === 1 ? '' : 's'}`);
  if (counts.tasks > 0) willLose.push(`${counts.tasks} remediation task${counts.tasks === 1 ? '' : 's'}`);
  if (counts.documents > 0)
    willLose.push(`${counts.documents} uploaded document${counts.documents === 1 ? '' : 's'} (and their stored files)`);
  if (counts.logEntries > 0)
    willLose.push(`${counts.logEntries} engagement-log entr${counts.logEntries === 1 ? 'y' : 'ies'}`);
  if (counts.hasValuation) willLose.push('the valuation & EBITDA recast');
  if (counts.hasDealOutcome)
    willLose.push('the recorded deal outcome (calibration data that cannot be re-derived)');
  willLose.push('the engagement agreement acceptance, data room, and all other records');

  const close = () => {
    if (busy) return;
    setOpen(false);
    setConfirmText('');
    setError(null);
  };

  const confirmDelete = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await invokeFunction('delete-engagement', { engagement_id: engagementId });
      // Everything keyed off this engagement is now stale, plus the book-level lists.
      qc.invalidateQueries({ queryKey: qk.engagements() });
      qc.invalidateQueries({ queryKey: qk.portfolio() });
      qc.removeQueries({ queryKey: qk.engagement(engagementId) });
      toast.show(`${companyName} engagement deleted`, 'good');
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <SectionCard title="Danger zone" subtitle="Irreversible actions for this engagement.">
      <div className="danger-zone">
        <div>
          <strong>Delete this engagement</strong>
          <p className="muted text-sm m-0">
            Permanently removes the engagement and everything under it. This cannot be undone. If the
            client simply finished or paused, use the status control above instead.
          </p>
        </div>
        <button className="btn-danger" onClick={() => setOpen(true)}>
          Delete engagement
        </button>
      </div>

      <ConfirmDialog
        open={open}
        danger
        title={`Delete ${companyName}?`}
        confirmLabel="Permanently delete"
        cancelLabel="Cancel"
        busy={busy}
        confirmDisabled={!matches}
        onCancel={close}
        onConfirm={confirmDelete}
      >
        <p className="m-0">
          This <strong>permanently and irreversibly</strong> deletes this engagement. There is no
          undo and no archive. It will destroy:
        </p>
        <ul className="danger-list">
          {willLose.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <label className="danger-confirm">
          <span>
            Type the client name <strong>{companyName}</strong> to confirm:
          </span>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={companyName}
            autoComplete="off"
            aria-label={`Type ${companyName} to confirm deletion`}
          />
        </label>
        {error && <ErrorState variant="inline" error={error} />}
      </ConfirmDialog>
    </SectionCard>
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
            <ErrorState variant="inline" error={compareQ.error} />
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
