// Central data layer (F0): every server-state read goes through TanStack Query
// with keys from one registry, so pages never fetch ad hoc and cache
// invalidation is precise. Supabase/PostgREST is the transport; these hooks are
// the only place components touch it for reads.
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { invokeFunction, supabase } from './supabase';
import { loadRubric, type RubricData } from './rubric';
import { buildPortfolioRows, type PortfolioRow } from './portfolio';

export type { PortfolioRow } from './portfolio';

// ---- key registry ----------------------------------------------------------
export const qk = {
  firm: (id: string) => ['firm', id] as const,
  branding: (firmId: string) => ['branding', firmId] as const,
  serviceTier: (firmId: string) => ['serviceTier', firmId] as const,
  companies: () => ['companies'] as const,
  company: (id: string) => ['company', id] as const,
  agreementVersions: () => ['agreementVersions'] as const,
  sourceDocuments: (engagementId: string) => ['sourceDocuments', engagementId] as const,
  dataRoom: (engagementId: string) => ['dataRoom', engagementId] as const,
  engagementLog: (engagementId: string) => ['engagementLog', engagementId] as const,
  comparables: (engagementId: string) => ['comparables', engagementId] as const,
  reviewQueue: () => ['reviewQueue'] as const,
  reconciliation: (engagementId: string) => ['reconciliation', engagementId] as const,
  engagementFindings: (engagementId: string) => ['engagementFindings', engagementId] as const,
  engagementReviewItems: (engagementId: string) => ['engagementReviewItems', engagementId] as const,
  graphSummary: (engagementId: string) => ['graphSummary', engagementId] as const,
  documentDetail: (id: string) => ['documentDetail', id] as const,
  engagements: () => ['engagements'] as const,
  engagement: (id: string) => ['engagement', id] as const,
  assessmentsByEngagement: (engagementId: string) =>
    ['assessments', 'byEngagement', engagementId] as const,
  activeAssessment: (id: string) => ['assessment', 'active', id] as const,
  assessment: (id: string) => ['assessment', 'raw', id] as const,
  rubricVersion: (id: string) => ['rubricVersion', id] as const,
  explain: (assessmentId: string) => ['explain', assessmentId] as const,
  latestReport: (assessmentId: string) => ['report', 'latest', assessmentId] as const,
  latestDoc: (assessmentId: string, docType: string) => ['doc', 'latest', assessmentId, docType] as const,
  rubric: (rubricVersionId: string) => ['rubric', rubricVersionId] as const,
  engineRubric: (rubricVersionId: string) => ['engineRubric', rubricVersionId] as const,
  answers: (assessmentId: string) => ['answers', assessmentId] as const,
  portfolio: () => ['portfolio'] as const,
  engagementGaps: (engagementId: string) => ['engagementGaps', engagementId] as const,
  engagementDocuments: (engagementId: string) => ['engagementDocuments', engagementId] as const,
  engagementOutcome: (engagementId: string) => ['engagementOutcome', engagementId] as const,
  compare: (priorId: string, currentId: string) => ['compare', priorId, currentId] as const,
  milestones: (engagementId: string) => ['milestones', engagementId] as const,
  tasks: (engagementId: string) => ['tasks', engagementId] as const,
  engagementEvents: (engagementId: string) => ['engagementEvents', engagementId] as const,
  advisoryLibrary: () => ['advisoryLibrary'] as const,
  plans: () => ['plans'] as const,
  contentModules: () => ['contentModules'] as const,
  firedAdvisory: (engagementId: string) => ['firedAdvisory', engagementId] as const,
  verification: (assessmentId: string) => ['verification', assessmentId] as const,
  ownerEngagement: (companyId: string) => ['ownerEngagement', companyId] as const,
  engagementCollaborators: (engagementId: string) => ['engagementCollaborators', engagementId] as const,
  firmProfessionals: (firmId: string) => ['firmProfessionals', firmId] as const,
  engagementProfessionals: (engagementId: string) => ['engagementProfessionals', engagementId] as const,
  firmEngagementRoster: (firmId: string) => ['firmEngagementRoster', firmId] as const,
  firmStaff: (firmId: string) => ['firmStaff', firmId] as const,
  education: (engagementId: string) => ['education', engagementId] as const,
  ledgerConnections: (companyId: string) => ['ledgerConnections', companyId] as const,
  valuation: (engagementId: string) => ['valuation', engagementId] as const,
  recast: (engagementId: string) => ['recast', engagementId] as const,
  valuationInputs: (engagementId: string) => ['valuationInputs', engagementId] as const,
} as const;

// ---- helpers ---------------------------------------------------------------
function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

async function selectOne<T>(table: string, id: string): Promise<T | null> {
  const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as T) ?? null;
}

// ---- typed rows (shared shapes) -------------------------------------------
export interface CompanyRow {
  id: string;
  firm_id: string;
  name: string;
  industry: string | null;
  revenue_band: string | null;
}
export interface EngagementRow {
  id: string;
  firm_id: string;
  company_id: string;
  advisor_id: string | null;
  status: string;
  target_exit_window: string | null;
  target_close_date: string | null;
  started_at: string;
}
export interface AssessmentRow {
  id: string;
  engagement_id: string;
  rubric_version_id: string;
  sequence_number: number;
  status: 'in_progress' | 'completed';
  completed_at: string | null;
  drs_score: number | null;
  drs_tier: string | null;
  ori_score: number | null;
  created_at: string;
}
export interface BrandingRow {
  firm_id: string;
  display_name: string | null;
  logo_url: string | null;
  accent_color: string | null;
  advisor_headshot_url: string | null;
  footer_disclosure_md: string | null;
  report_from_line: string | null;
}

// ---- read hooks ------------------------------------------------------------
export function useCompanies(): UseQueryResult<CompanyRow[]> {
  return useQuery({
    queryKey: qk.companies(),
    queryFn: async () =>
      unwrap<CompanyRow[]>(await supabase.from('companies').select('*').order('name')),
  });
}

export interface AgreementVersionRow {
  id: string;
  firm_id: string;
  version_label: string;
  title: string;
  body_md: string;
  status: 'draft' | 'active' | 'retired';
  effective_date: string;
}

// Active engagement-agreement versions for the caller's firm (RLS-scoped),
// newest effective first — the first row is the one to accept at onboarding.
export function useActiveAgreementVersions(): UseQueryResult<AgreementVersionRow[]> {
  return useQuery({
    queryKey: qk.agreementVersions(),
    queryFn: async () =>
      unwrap<AgreementVersionRow[]>(
        await supabase
          .from('agreement_versions')
          .select('*')
          .eq('status', 'active')
          .order('effective_date', { ascending: false }),
      ),
  });
}

export function useCompany(id: string | undefined): UseQueryResult<CompanyRow | null> {
  return useQuery({
    queryKey: qk.company(id ?? ''),
    enabled: !!id,
    queryFn: () => selectOne<CompanyRow>('companies', id!),
  });
}

export function useEngagements(): UseQueryResult<EngagementRow[]> {
  return useQuery({
    queryKey: qk.engagements(),
    queryFn: async () => unwrap<EngagementRow[]>(await supabase.from('engagements').select('*')),
  });
}

export function useEngagement(id: string | undefined): UseQueryResult<EngagementRow | null> {
  return useQuery({
    queryKey: qk.engagement(id ?? ''),
    enabled: !!id,
    queryFn: () => selectOne<EngagementRow>('engagements', id!),
  });
}

// Longitudinal read path: active assessments only (docs/02).
export function useAssessmentsByEngagement(
  engagementId: string | undefined,
): UseQueryResult<AssessmentRow[]> {
  return useQuery({
    queryKey: qk.assessmentsByEngagement(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () =>
      unwrap<AssessmentRow[]>(
        await supabase
          .from('active_assessments')
          .select('*')
          .eq('engagement_id', engagementId!)
          .order('sequence_number'),
      ),
  });
}

export function useActiveAssessment(id: string | undefined): UseQueryResult<AssessmentRow | null> {
  return useQuery({
    queryKey: qk.activeAssessment(id ?? ''),
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('active_assessments')
        .select('*')
        .eq('id', id!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as AssessmentRow) ?? null;
    },
  });
}

export function useRubricVersion(
  id: string | undefined,
): UseQueryResult<{ id: string; version_label: string } | null> {
  return useQuery({
    queryKey: qk.rubricVersion(id ?? ''),
    enabled: !!id,
    queryFn: () => selectOne<{ id: string; version_label: string }>('rubric_versions', id!),
  });
}

export interface ExplainResultShape {
  subScores: {
    code: string;
    name: string;
    dimensionCode: string;
    formulaType: string;
    inputs: Record<string, unknown>;
    computed: Record<string, unknown>;
    points: number;
    weight: number;
    contribution: number;
  }[];
  dimensions: {
    code: string;
    name: string;
    score: number;
    drsWeight: number;
    contributionToDrs: number;
  }[];
  drsScore: number;
  drsTier: string;
  oriScore: number;
  firedGaps: { code: string; name: string; severity: string; trigger: unknown }[];
  flags: string[];
  projectedDrs: number;
}

export function useExplain(assessmentId: string | undefined): UseQueryResult<ExplainResultShape> {
  return useQuery({
    queryKey: qk.explain(assessmentId ?? ''),
    enabled: !!assessmentId,
    queryFn: () => invokeFunction<ExplainResultShape>('explain-assessment', { assessment_id: assessmentId }),
  });
}

export interface GeneratedDocumentRow {
  id: string;
  assessment_id: string;
  engagement_id: string;
  content_md: string;
  prompt_version: string;
  model: string;
  created_at: string;
  finalized_at: string | null;
}

export function useLatestReport(
  assessmentId: string | undefined,
): UseQueryResult<GeneratedDocumentRow | null> {
  return useQuery({
    queryKey: qk.latestReport(assessmentId ?? ''),
    enabled: !!assessmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('generated_documents')
        .select('*')
        .eq('assessment_id', assessmentId!)
        .eq('doc_type', 'owner_report')
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return ((data?.[0] as GeneratedDocumentRow) ?? null) || null;
    },
  });
}

// Latest generated document of a given type for an assessment. Generalizes
// useLatestReport (owner_report) so the CIM deliverable page can reuse the same
// generate → edit → finalize flow.
export function useLatestDoc(
  assessmentId: string | undefined,
  docType: string,
): UseQueryResult<GeneratedDocumentRow | null> {
  return useQuery({
    queryKey: qk.latestDoc(assessmentId ?? '', docType),
    enabled: !!assessmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('generated_documents')
        .select('*')
        .eq('assessment_id', assessmentId!)
        .eq('doc_type', docType)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return ((data?.[0] as GeneratedDocumentRow) ?? null) || null;
    },
  });
}

// CIM evidence coverage: which CIM sections are backed by Ready/verified
// data-room evidence, and what is still missing. Read-only; drives the CIM
// readiness panel that postures evidence collection toward the memorandum.
export interface CimSectionCoverageShape {
  code: string;
  name: string;
  narrative: boolean;
  itemsTotal: number;
  itemsReady: number;
  itemsVerified: number;
  pct: number;
  missing: { item_code: string; label: string; section_code: string; readiness_state: string }[];
}
export interface CimCoverageShape {
  sections: CimSectionCoverageShape[];
  summary: {
    evidenceSections: number;
    itemsTotal: number;
    itemsReady: number;
    itemsVerified: number;
    pct: number;
  };
}

export function useCimCoverage(engagementId: string | undefined): UseQueryResult<CimCoverageShape> {
  return useQuery({
    queryKey: ['cimCoverage', engagementId ?? ''],
    enabled: !!engagementId,
    queryFn: () => invokeFunction<CimCoverageShape>('cim-coverage', { engagement_id: engagementId }),
  });
}

// In-app "Needs attention" worklist for the caller's firm (docs/archive/35 Phase 9).
export interface AttentionShape {
  generatedAt: string;
  thresholds: { staleDays: number; stalledDays: number; reassessDays: number };
  counts: {
    reassessmentReady: number;
    reassessmentDue: number;
    stalledTasks: number;
    staleEngagements: number;
    total: number;
  };
  // "Properly placed" reassessments — a Plan's work finished since the last
  // measurement (docs/37 PL4). Listed ahead of the time-cadence due list.
  reassessmentReady: {
    engagementId: string;
    companyName: string | null;
    planCompletedAt: string | null;
    readyPlanCount: number;
    readyPlanNames: string | null;
  }[];
  reassessmentDue: {
    engagementId: string;
    companyName: string | null;
    daysSinceLastAssessment: number;
    lastCompletedAt: string | null;
  }[];
  stalledTasks: {
    taskId: string;
    engagementId: string;
    companyName: string | null;
    title: string;
    ownerRole: string;
    dueDate: string | null;
    pastDue: boolean;
    daysStalled: number;
    daysOverdue: number;
  }[];
  staleEngagements: {
    engagementId: string;
    companyName: string | null;
    daysStale: number;
    lastActivityAt: string | null;
  }[];
}

export function useFirmAttention(enabled = true): UseQueryResult<AttentionShape> {
  return useQuery({
    queryKey: ['firmAttention'],
    enabled,
    queryFn: () => invokeFunction<AttentionShape>('firm-attention', {}),
  });
}

export interface AnswerRowRaw {
  question_id: string;
  value: unknown;
}

// Display rubric (dimensions + questions grouped) for intake/workbench.
export function useRubric(rubricVersionId: string | undefined): UseQueryResult<RubricData> {
  return useQuery({
    queryKey: qk.rubric(rubricVersionId ?? ''),
    enabled: !!rubricVersionId,
    staleTime: 5 * 60_000, // rubric is immutable per version
    queryFn: () => loadRubric(rubricVersionId!),
  });
}

// Saved answers for an assessment (raw rows keyed by question id).
export function useAnswers(assessmentId: string | undefined): UseQueryResult<AnswerRowRaw[]> {
  return useQuery({
    queryKey: qk.answers(assessmentId ?? ''),
    enabled: !!assessmentId,
    queryFn: async () =>
      unwrap<AnswerRowRaw[]>(
        await supabase.from('answers').select('*').eq('assessment_id', assessmentId!),
      ),
  });
}

// ---- portfolio (F2) --------------------------------------------------------
// PortfolioRow lives in ./portfolio (pure, unit-tested). The delta is computed
// there and is rubric-version-aware: cross-version priors are marked
// incomparable rather than differenced into a meaningless number.

export function usePortfolio(): UseQueryResult<PortfolioRow[]> {
  return useQuery({
    queryKey: qk.portfolio(),
    queryFn: async () => {
      const [engagements, companies, assessments, gaps] = await Promise.all([
        supabase.from('engagements').select('*'),
        supabase.from('companies').select('*'),
        supabase.from('active_assessments').select('*').eq('status', 'completed').order('sequence_number'),
        supabase.from('gaps').select('engagement_id,status').in('status', ['open', 'in_remediation']),
      ]);
      for (const r of [engagements, companies, assessments, gaps]) {
        if (r.error) throw new Error(r.error.message);
      }
      return buildPortfolioRows(
        (engagements.data ?? []) as EngagementRow[],
        (companies.data ?? []) as CompanyRow[],
        (assessments.data ?? []) as AssessmentRow[],
        (gaps.data ?? []) as { engagement_id: string; status: string }[],
      );
    },
  });
}

// ---- engagement command view (F3) -----------------------------------------
export interface EngagementGap {
  id: string;
  code: string;
  name: string;
  severity: 'low' | 'med' | 'high' | 'critical';
  status: string;
  playbookName: string | null;
  playbookSummary: string | null;
}

export interface BurndownPoint {
  seq: number;
  date: string | null;
  critical: number;
  high: number;
  med: number;
  low: number;
  total: number;
}

// Open gaps by severity as of each completed assessment — the burn-down that
// shows remediation progress. A gap is open as of assessment A if it was opened
// at/before A and not resolved until after A. Joined client-side (the dev REST
// surface has no joins), like useEngagementGaps.
export function useGapBurndown(
  engagementId: string | undefined,
  rubricVersionId: string | undefined,
): UseQueryResult<BurndownPoint[]> {
  return useQuery({
    queryKey: ['gapBurndown', engagementId ?? ''],
    enabled: !!engagementId && !!rubricVersionId,
    queryFn: async () => {
      const [gaps, defs, assess] = await Promise.all([
        supabase.from('gaps').select('*').eq('engagement_id', engagementId!),
        supabase.from('gap_definitions').select('*').eq('rubric_version_id', rubricVersionId!),
        supabase.from('assessments').select('*').eq('engagement_id', engagementId!).eq('status', 'completed'),
      ]);
      for (const r of [gaps, defs, assess]) if (r.error) throw new Error(r.error.message);
      const sevById = new Map(
        (defs.data ?? []).map((d: { id: string; severity: string }) => [d.id, d.severity]),
      );
      const completed = ([...(assess.data ?? [])] as {
        id: string;
        sequence_number: number;
        completed_at: string;
      }[]).sort((a, b) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
      const byId = new Map(completed.map((a) => [a.id, a]));
      const allGaps = (gaps.data ?? []) as {
        gap_definition_id: string;
        opened_by_assessment_id: string;
        resolved_by_assessment_id: string | null;
      }[];
      return completed.map((a) => {
        const cA = new Date(a.completed_at).getTime();
        const counts = { critical: 0, high: 0, med: 0, low: 0 } as Record<string, number>;
        for (const g of allGaps) {
          const opener = byId.get(g.opened_by_assessment_id);
          if (!opener || new Date(opener.completed_at).getTime() > cA) continue;
          if (g.resolved_by_assessment_id) {
            const res = byId.get(g.resolved_by_assessment_id);
            if (res && new Date(res.completed_at).getTime() <= cA) continue;
          }
          const sev = sevById.get(g.gap_definition_id) ?? 'med';
          counts[sev] = (counts[sev] ?? 0) + 1;
        }
        return {
          seq: a.sequence_number,
          date: a.completed_at,
          critical: counts.critical,
          high: counts.high,
          med: counts.med,
          low: counts.low,
          total: counts.critical + counts.high + counts.med + counts.low,
        };
      });
    },
  });
}

export function useEngagementGaps(
  engagementId: string | undefined,
  rubricVersionId: string | undefined,
): UseQueryResult<EngagementGap[]> {
  return useQuery({
    queryKey: qk.engagementGaps(engagementId ?? ''),
    enabled: !!engagementId && !!rubricVersionId,
    queryFn: async () => {
      const [gaps, defs, maps, playbooks] = await Promise.all([
        supabase
          .from('gaps')
          .select('*')
          .eq('engagement_id', engagementId!)
          .in('status', ['open', 'in_remediation']),
        supabase.from('gap_definitions').select('*').eq('rubric_version_id', rubricVersionId!),
        supabase.from('gap_playbook_map').select('*'),
        supabase.from('playbooks').select('*'),
      ]);
      for (const r of [gaps, defs, maps, playbooks]) if (r.error) throw new Error(r.error.message);
      const defById = new Map((defs.data ?? []).map((d: { id: string; code: string; name: string; severity: string }) => [d.id, d]));
      const pbById = new Map((playbooks.data ?? []).map((p: { id: string; name: string; summary: string }) => [p.id, p]));
      const pbByGapDef = new Map<string, { name: string; summary: string }>();
      for (const m of (maps.data ?? []) as { gap_definition_id: string; playbook_id: string }[]) {
        const pb = pbById.get(m.playbook_id);
        if (pb && !pbByGapDef.has(m.gap_definition_id)) pbByGapDef.set(m.gap_definition_id, pb);
      }
      const severityRank: Record<string, number> = { critical: 0, high: 1, med: 2, low: 3 };
      return ((gaps.data ?? []) as { id: string; gap_definition_id: string; status: string }[])
        .map((g) => {
          const def = defById.get(g.gap_definition_id);
          const pb = def ? pbByGapDef.get(g.gap_definition_id) : null;
          return {
            id: g.id,
            code: def?.code ?? '',
            name: def?.name ?? 'Unknown gap',
            severity: (def?.severity ?? 'med') as EngagementGap['severity'],
            status: g.status,
            playbookName: pb?.name ?? null,
            playbookSummary: pb?.summary ?? null,
          };
        })
        .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
    },
  });
}

export interface DealOutcomeRow {
  outcome: 'closed' | 'broken' | 'withdrawn';
  close_date: string | null;
  days_on_market: number | null;
  final_ev: number | null;
  final_multiple: number | null;
  ebitda_at_close: number | null;
  buyer_type: string | null;
  structure: string | null;
  retrade: boolean;
  retrade_pct: number | null;
  buyer_flagged_risks: string[] | null;
  notes: string | null;
  updated_at: string | null;
}

// The recorded outcome for an engagement (moat #1 calibration substrate). Read
// under RLS; written via the record-deal-outcome function (which snapshots the
// prediction). Null until recorded.
export function useDealOutcome(
  engagementId: string | undefined,
): UseQueryResult<DealOutcomeRow | null> {
  return useQuery({
    queryKey: engagementId ? ['dealOutcome', engagementId] : ['dealOutcome', ''],
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deal_outcomes')
        .select('outcome, close_date, days_on_market, final_ev, final_multiple, ebitda_at_close, buyer_type, structure, retrade, retrade_pct, buyer_flagged_risks, notes, updated_at')
        .eq('engagement_id', engagementId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as DealOutcomeRow) ?? null;
    },
  });
}

export interface ComparableRow {
  engagementId: string;
  companyName: string;
  industry: string | null;
  sizeBand: string | null;
  drs: number | null;
  tier: string | null;
  outcomeStatus: string | null;
  sharedGaps: string[];
  reasons: string[];
  score: number;
}

// Comparable engagements from the firm's own book (docs/archive/21 Category B).
export function useComparables(
  engagementId: string | undefined,
): UseQueryResult<ComparableRow[]> {
  return useQuery({
    queryKey: engagementId ? qk.comparables(engagementId) : ['comparables', ''],
    enabled: !!engagementId,
    queryFn: async () => {
      const r = await invokeFunction<{ comparables: ComparableRow[] }>('engagement-comparables', {
        engagement_id: engagementId,
      });
      return r.comparables;
    },
  });
}

export interface EngagementLogRow {
  id: string;
  kind: 'meeting' | 'decision' | 'rationale' | 'note';
  occurred_on: string;
  title: string;
  detail: string | null;
  gap_id: string | null;
  author_id: string | null;
  created_at: string;
}

// Institutional memory (docs/archive/21 Category B): the advisor's meetings, decisions,
// and rationale for this engagement. Staff-only under RLS.
export function useEngagementLog(
  engagementId: string | undefined,
): UseQueryResult<EngagementLogRow[]> {
  return useQuery({
    queryKey: qk.engagementLog(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagement_log')
        .select('id, kind, occurred_on, title, detail, gap_id, author_id, created_at')
        .eq('engagement_id', engagementId!)
        .order('occurred_on', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data as EngagementLogRow[]) ?? [];
    },
  });
}

export function useEngagementDocuments(
  engagementId: string | undefined,
): UseQueryResult<(GeneratedDocumentRow & { doc_type: string; assessment_id: string })[]> {
  return useQuery({
    queryKey: qk.engagementDocuments(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () =>
      unwrap(
        await supabase
          .from('generated_documents')
          .select('*')
          .eq('engagement_id', engagementId!)
          .order('created_at', { ascending: false }),
      ),
  });
}

export function useEngagementOutcome(
  engagementId: string | undefined,
): UseQueryResult<{ process_status: string | null } | null> {
  return useQuery({
    queryKey: qk.engagementOutcome(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagement_outcomes')
        .select('*')
        .eq('engagement_id', engagementId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { process_status: string | null }) ?? null;
    },
  });
}

export type CompareResult =
  | { comparable: false; reason: string; prior_version: string; current_version: string }
  | {
      comparable: true;
      prior: { assessmentId: string; drsScore: number; drsTier: string; oriScore: number };
      current: { assessmentId: string; drsScore: number; drsTier: string; oriScore: number };
      drsDelta: number;
      oriDelta: number;
      dimensions: { code: string; prior: number; current: number; delta: number }[];
      subScores: { code: string; prior: number; current: number; delta: number }[];
      gapsOpened: string[];
      gapsResolved: string[];
    };

export function useCompare(
  priorId: string | undefined,
  currentId: string | undefined,
): UseQueryResult<CompareResult> {
  return useQuery({
    queryKey: qk.compare(priorId ?? '', currentId ?? ''),
    enabled: !!priorId && !!currentId && priorId !== currentId,
    queryFn: () =>
      invokeFunction<CompareResult>('compare-assessments', {
        prior_assessment_id: priorId,
        current_assessment_id: currentId,
      }),
  });
}

export function useLatestDocument(
  assessmentId: string | undefined,
  docType: string,
): UseQueryResult<GeneratedDocumentRow | null> {
  return useQuery({
    queryKey: qk.latestDoc(assessmentId ?? '', docType),
    enabled: !!assessmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('generated_documents')
        .select('*')
        .eq('assessment_id', assessmentId!)
        .eq('doc_type', docType)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return ((data?.[0] as GeneratedDocumentRow) ?? null) || null;
    },
  });
}

// ---- roadmap (F5) ----------------------------------------------------------
export interface TaskRow {
  id: string;
  engagement_id: string;
  gap_id: string | null;
  playbook_id: string | null;
  title: string;
  description: string | null;
  owner_role: string;
  status: 'todo' | 'doing' | 'done' | 'blocked';
  due_date: string | null;
  sequence: number | null;
  display_order: number | null;
}
export interface MilestoneRow {
  id: string;
  engagement_id: string;
  track: 'business' | 'personal';
  title: string;
  description: string | null;
  target_date: string | null;
  completed_at: string | null;
  sort_order: number;
}

export function useTasks(engagementId: string | undefined): UseQueryResult<TaskRow[]> {
  return useQuery({
    queryKey: qk.tasks(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () =>
      unwrap<TaskRow[]>(
        await supabase
          .from('tasks')
          .select('*')
          .eq('engagement_id', engagementId!)
          .order('due_date', { ascending: true }),
      ),
  });
}

export function useMilestones(engagementId: string | undefined): UseQueryResult<MilestoneRow[]> {
  return useQuery({
    queryKey: qk.milestones(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () =>
      unwrap<MilestoneRow[]>(
        await supabase
          .from('roadmap_milestones')
          .select('*')
          .eq('engagement_id', engagementId!)
          .order('target_date', { ascending: true }),
      ),
  });
}

// Playbook id -> descriptive metadata, for grouping roadmap tasks into
// workstreams and for annotating the Plan authoring picker (dimension/summary).
export interface PlaybookMeta {
  name: string;
  phase: string | null;
  dimension_code: string | null;
  summary: string | null;
  ev_impact: string | null;
}
export function usePlaybooks(): UseQueryResult<Map<string, PlaybookMeta>> {
  return useQuery({
    queryKey: ['playbooks'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('playbooks').select('id,name,phase,dimension_code,summary,ev_impact');
      if (error) throw new Error(error.message);
      return new Map(
        (data ?? []).map((p: { id: string } & PlaybookMeta) => [
          p.id,
          { name: p.name, phase: p.phase, dimension_code: p.dimension_code, summary: p.summary, ev_impact: p.ev_impact },
        ]),
      );
    },
  });
}

// ---- advisory library ------------------------------------------------------
export type AdvisoryItemType = 'buyer_question' | 'initiative' | 'risk_flag' | 'education';

export interface AdvisoryItemRow {
  id: string;
  firm_id: string | null;
  source: 'system' | 'advisor';
  item_type: AdvisoryItemType;
  code: string | null;
  title: string;
  body: string;
  response_framework: string | null;
  data_needed: string | null;
  dimension_code: string | null;
  sub_score_code: string | null;
  severity: string | null;
  buyer_type: string | null;
  score_trigger: number | null;
  active: boolean;
  sort_order: number;
}

export interface FiredAdvisoryItem extends AdvisoryItemRow {
  score_trigger: number;
  governing_code: string;
  governing_score: number;
}

export interface FiredAdvisoryResult {
  assessment_id: string | null;
  items: FiredAdvisoryItem[];
  counts: {
    buyer_question: number;
    initiative: number;
    risk_flag: number;
    critical: number;
    high: number;
  };
}

// The full catalog visible to this user: global system items + own firm items.
export function useAdvisoryLibrary(): UseQueryResult<AdvisoryItemRow[]> {
  return useQuery({
    queryKey: qk.advisoryLibrary(),
    staleTime: 60_000,
    queryFn: async () =>
      unwrap<AdvisoryItemRow[]>(
        await supabase
          .from('advisory_library_items')
          .select('*')
          .order('item_type', { ascending: true })
          .order('sort_order', { ascending: true }),
      ),
  });
}

// The items that fire for an engagement's latest completed assessment.
export function useFiredAdvisory(
  engagementId: string | undefined,
): UseQueryResult<FiredAdvisoryResult> {
  return useQuery({
    queryKey: qk.firedAdvisory(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: () =>
      invokeFunction<FiredAdvisoryResult>('advisory-items', { engagement_id: engagementId }),
  });
}

// ---- financial verification (Phase 1) --------------------------------------
export type ProvenanceSource = 'self_reported' | 'document' | 'connected_ledger';
export type VerificationTier = 'self_reported' | 'partly_verified' | 'document_verified';

export interface VerificationInput {
  question_id: string;
  question_code: string;
  prompt: string;
  dimension_code: string;
  source: ProvenanceSource;
}
export interface VerificationSummary {
  verified_inputs: number;
  total_inputs: number;
  pct: number;
  tier: VerificationTier;
  inputs: VerificationInput[];
}

// Per-question provenance for an assessment (question_id -> source), so intake
// can badge ledger-filled answers and downgrade them when edited by hand.
export function useAnswerProvenance(
  assessmentId: string | undefined,
): UseQueryResult<Record<string, ProvenanceSource>> {
  return useQuery({
    queryKey: ['answerProvenance', assessmentId ?? ''],
    enabled: !!assessmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('answer_provenance')
        .select('question_id,source')
        .eq('assessment_id', assessmentId!);
      if (error) throw new Error(error.message);
      return Object.fromEntries(
        (data ?? []).map((r: { question_id: string; source: ProvenanceSource }) => [r.question_id, r.source]),
      );
    },
  });
}

export function useVerification(
  assessmentId: string | undefined,
): UseQueryResult<VerificationSummary> {
  return useQuery({
    queryKey: qk.verification(assessmentId ?? ''),
    enabled: !!assessmentId,
    queryFn: () =>
      invokeFunction<VerificationSummary>('verification-summary', { assessment_id: assessmentId }),
  });
}

// ---- owner portal (Phase 3) ------------------------------------------------
// The owner's engagement, resolved from their company (RLS returns only theirs).
export function useOwnerEngagement(
  companyId: string | undefined | null,
): UseQueryResult<EngagementRow | null> {
  return useQuery({
    queryKey: qk.ownerEngagement(companyId ?? ''),
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagements')
        .select('*')
        .eq('company_id', companyId!)
        .order('started_at', { ascending: false });
      if (error) throw new Error(error.message);
      return ((data ?? [])[0] as EngagementRow) ?? null;
    },
  });
}

export interface LedgerConnection {
  id: string;
  firm_id: string;
  company_id: string;
  provider: 'quickbooks' | 'xero';
  status: 'disconnected' | 'connected' | 'error';
  external_org_name: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
}

export function useLedgerConnections(
  companyId: string | undefined | null,
): UseQueryResult<LedgerConnection[]> {
  return useQuery({
    queryKey: qk.ledgerConnections(companyId ?? ''),
    enabled: !!companyId,
    queryFn: async () =>
      unwrap<LedgerConnection[]>(
        await supabase.from('ledger_connections').select('*').eq('company_id', companyId!),
      ),
  });
}

// Education pieces sourced from the Advisory Library (item_type = education),
// each flagged recommended when its score trigger has tripped — the same firing
// rule as the rest of the library.
export interface EducationLibraryModule {
  id: string;
  code: string | null;
  title: string;
  body: string;
  dimension_code: string | null;
  recommended: boolean;
}
export interface EducationModulesResult {
  assessment_id: string | null;
  modules: EducationLibraryModule[];
}
export function useEducationModules(
  engagementId: string | undefined,
): UseQueryResult<EducationModulesResult> {
  return useQuery({
    queryKey: qk.education(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: () =>
      invokeFunction<EducationModulesResult>('education-modules', { engagement_id: engagementId }),
  });
}

// ---- valuation (Phase 2) ---------------------------------------------------
export interface ValuationResult {
  has_recast: boolean;
  rules_version: string | null;
  reported_ebitda: number;
  defensible_ebitda: number;
  full_recast_ebitda: number;
  industry_key: string;
  size_band: string;
  base_multiple: number;
  multiple_source: 'table' | 'override';
  drs_score: number | null;
  drs_tier: string | null;
  readiness_factor: number;
  verification_tier: string;
  range_width: number;
  ev_base: number;
  ev_low: number;
  ev_high: number;
  potential_ev: number;
  value_creation_gap: number;
  interest_bearing_debt: number;
  transaction_cost_pct: number;
  transaction_costs: number;
  tax_rate: number;
  taxes: number;
  net_proceeds: number;
  owner_wealth_target: number | null;
  wealth_gap: number | null;
}

export function useValuation(engagementId: string | undefined): UseQueryResult<ValuationResult> {
  return useQuery({
    queryKey: qk.valuation(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: () => invokeFunction<ValuationResult>('compute-valuation', { engagement_id: engagementId }),
  });
}

export interface RecastRow {
  id: string;
  engagement_id: string;
  reported_ebitda: number;
  fiscal_year: number | null;
  notes: string | null;
}
export interface AddbackRow {
  id: string;
  recast_id: string;
  label: string;
  category: string | null;
  amount: number;
  challenge_likelihood: 'low' | 'medium' | 'high' | 'not_defensible';
  documented: boolean;
  note: string | null;
}
export interface ValuationInputsRow {
  id: string;
  engagement_id: string;
  industry_key: string | null;
  multiple_override: number | null;
  interest_bearing_debt: number;
  transaction_cost_pct: number | null;
  tax_rate: number | null;
  owner_wealth_target: number | null;
}

export function useRecast(
  engagementId: string | undefined,
): UseQueryResult<{ recast: RecastRow | null; addbacks: AddbackRow[] }> {
  return useQuery({
    queryKey: qk.recast(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data: recast, error } = await supabase
        .from('ebitda_recasts')
        .select('*')
        .eq('engagement_id', engagementId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!recast) return { recast: null, addbacks: [] };
      const { data: addbacks, error: aErr } = await supabase
        .from('ebitda_addbacks')
        .select('*')
        .eq('recast_id', (recast as RecastRow).id)
        .order('created_at');
      if (aErr) throw new Error(aErr.message);
      return { recast: recast as RecastRow, addbacks: (addbacks ?? []) as AddbackRow[] };
    },
  });
}

export function useValuationInputs(
  engagementId: string | undefined,
): UseQueryResult<ValuationInputsRow | null> {
  return useQuery({
    queryKey: qk.valuationInputs(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('valuation_inputs')
        .select('*')
        .eq('engagement_id', engagementId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as ValuationInputsRow) ?? null;
    },
  });
}

// ---- owner invitation (advisor) --------------------------------------------
export interface OwnerProfileRow {
  id: string;
  full_name: string | null;
  email: string | null;
  company_id: string | null;
}
export function useOwnerProfile(
  companyId: string | undefined,
): UseQueryResult<OwnerProfileRow | null> {
  return useQuery({
    queryKey: ['ownerProfile', companyId ?? ''],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id,full_name,email,company_id')
        .eq('company_id', companyId!)
        .eq('role', 'owner')
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as OwnerProfileRow) ?? null;
    },
  });
}

// ---- engagement collaborators (view-only external team) --------------------
export interface EngagementCollaboratorRow {
  id: string;
  email: string;
  full_name: string | null;
  kind: 'cpa' | 'attorney' | 'advisor' | 'other';
  status: 'invited' | 'active' | 'revoked';
  created_at: string;
}
// The engagement's view-only external team (CPA, attorney, …). Revoked rows are
// filtered out — this is the live roster the advisor manages. Read under RLS
// (staff-only), so it returns nothing for owners/collaborators.
export function useEngagementCollaborators(
  engagementId: string | undefined,
): UseQueryResult<EngagementCollaboratorRow[]> {
  return useQuery({
    queryKey: qk.engagementCollaborators(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagement_collaborators')
        .select('id,email,full_name,kind,status,created_at')
        .eq('engagement_id', engagementId!)
        .neq('status', 'revoked')
        .order('created_at');
      if (error) throw new Error(error.message);
      return (data as EngagementCollaboratorRow[]) ?? [];
    },
  });
}

export function useBranding(firmId: string | undefined | null): UseQueryResult<BrandingRow | null> {
  return useQuery({
    queryKey: qk.branding(firmId ?? ''),
    enabled: !!firmId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('firm_branding')
        .select('*')
        .eq('firm_id', firmId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as BrandingRow) ?? null;
    },
  });
}

export interface ServiceTierRow {
  firm_id: string;
  tier: string;
  selected_by: string | null;
  created_at: string;
  updated_at: string;
}

// The firm's selected service tier (first-run onboarding). Null until chosen.
export function useServiceTier(
  firmId: string | undefined | null,
): UseQueryResult<ServiceTierRow | null> {
  return useQuery({
    queryKey: qk.serviceTier(firmId ?? ''),
    enabled: !!firmId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('firm_service_tier')
        .select('*')
        .eq('firm_id', firmId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as ServiceTierRow) ?? null;
    },
  });
}

// ── Plans (docs/37) ──────────────────────────────────────────────────────────
export type PlanItemKind = 'playbook' | 'education' | 'advisory' | 'milestone' | 'manual_task';

export interface PlanItemView {
  id: string;
  item_kind: PlanItemKind;
  playbook_id: string | null;
  content_module_id: string | null;
  advisory_library_item_id: string | null;
  title: string | null;
  description: string | null;
  owner_role: string | null;
  track: string | null;
  target_offset_days: number | null;
  sort_order: number;
}

export interface PlanView {
  id: string;
  firm_id: string | null;
  is_system: boolean;
  source: string;
  code: string | null;
  lineage_id: string | null;
  name: string;
  summary: string | null;
  plan_version: number;
  status: string;
  items: PlanItemView[];
}

// System Plans + the caller firm's own (server list-plans; RLS + firm filter).
export function usePlans(): UseQueryResult<PlanView[]> {
  return useQuery({
    queryKey: qk.plans(),
    queryFn: async () => (await invokeFunction<{ plans: PlanView[] }>('list-plans', {})).plans,
  });
}

export interface ContentModuleRow {
  id: string;
  code: string;
  title: string;
  dimension_code: string | null;
}

// The education catalog (global methodology), for the Plan item picker.
export function useContentModules(): UseQueryResult<ContentModuleRow[]> {
  return useQuery({
    queryKey: qk.contentModules(),
    queryFn: async () => {
      const { data, error } = await supabase.from('content_modules').select('id,code,title,dimension_code').order('title');
      if (error) throw error;
      return (data ?? []) as ContentModuleRow[];
    },
  });
}

// Applied-Plan progress for an engagement (docs/37 PL4).
export interface EngagementPlanProgressRow {
  id: string;
  plan_template_id: string;
  name: string;
  status: string;
  applied_plan_version: number;
  anchor_date: string | null;
  total: number;
  done: number;
  pct: number;
  completed_at: string | null;
}

export function useEngagementPlans(engagementId: string | undefined): UseQueryResult<EngagementPlanProgressRow[]> {
  return useQuery({
    queryKey: ['engagementPlans', engagementId ?? ''],
    enabled: !!engagementId,
    queryFn: async () =>
      (await invokeFunction<{ plans: EngagementPlanProgressRow[] }>('list-engagement-plans', {
        engagement_id: engagementId,
      })).plans,
  });
}

// Score-driven Plan recommendations for an engagement (docs/37 Q5).
export interface PlanRecommendationRow {
  plan_template_id: string;
  name: string;
  is_system: boolean;
  matched_gap_count: number;
  matched_gap_codes: string[];
}

export function useRecommendedPlans(engagementId: string | undefined): UseQueryResult<PlanRecommendationRow[]> {
  return useQuery({
    queryKey: ['recommendedPlans', engagementId ?? ''],
    enabled: !!engagementId,
    queryFn: async () =>
      (await invokeFunction<{ recommendations: PlanRecommendationRow[] }>('recommend-plans', {
        engagement_id: engagementId,
      })).recommendations,
  });
}

// ── Firm professional directory ──────────────────────────────────────────────
// The firm-level address book of the clients' outside professionals (CPAs,
// attorneys, M&A advisors, …). Read under RLS (staff-only), managed by admins.
export type ProfessionalKind =
  | 'cpa'
  | 'attorney'
  | 'ma_advisor'
  | 'banker'
  | 'wealth_manager'
  | 'insurance'
  | 'other';

export interface FirmProfessionalRow {
  id: string;
  full_name: string;
  organization: string | null;
  kind: ProfessionalKind;
  email: string | null;
  phone: string | null;
  notes: string | null;
  archived: boolean;
  created_at: string;
}

export function useFirmProfessionals(
  firmId: string | undefined | null,
  opts: { includeArchived?: boolean } = {},
): UseQueryResult<FirmProfessionalRow[]> {
  return useQuery({
    queryKey: qk.firmProfessionals(firmId ?? ''),
    enabled: !!firmId,
    queryFn: async () => {
      let q = supabase
        .from('firm_professionals')
        .select('id,full_name,organization,kind,email,phone,notes,archived,created_at')
        .eq('firm_id', firmId!)
        .order('full_name');
      if (!opts.includeArchived) q = q.eq('archived', false);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data as FirmProfessionalRow[]) ?? [];
    },
  });
}

// The directory professionals attached to one engagement's deal team, joined to
// the directory row so the card can show name/org/kind without a second fetch.
export interface EngagementProfessionalRow {
  id: string;
  professional_id: string;
  engagement_role: string | null;
  created_at: string;
  professional: {
    full_name: string;
    organization: string | null;
    kind: ProfessionalKind;
    email: string | null;
    phone: string | null;
  } | null;
}

export function useEngagementProfessionals(
  engagementId: string | undefined,
): UseQueryResult<EngagementProfessionalRow[]> {
  return useQuery({
    queryKey: qk.engagementProfessionals(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagement_professionals')
        .select(
          'id,professional_id,engagement_role,created_at,professional:firm_professionals(full_name,organization,kind,email,phone)',
        )
        .eq('engagement_id', engagementId!)
        .order('created_at');
      if (error) throw new Error(error.message);
      return (data as unknown as EngagementProfessionalRow[]) ?? [];
    },
  });
}

// Firm-wide engagement roster for the admin assignment view: every engagement,
// its company, and its current owning advisor. Read under RLS (firm-scoped).
export interface FirmEngagementRosterRow {
  id: string;
  status: string;
  advisor_id: string | null;
  company: { name: string } | null;
  advisor: { full_name: string | null; email: string | null } | null;
}

export function useFirmEngagementRoster(
  firmId: string | undefined | null,
): UseQueryResult<FirmEngagementRosterRow[]> {
  return useQuery({
    queryKey: qk.firmEngagementRoster(firmId ?? ''),
    enabled: !!firmId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagements')
        .select(
          'id,status,advisor_id,company:companies(name),advisor:profiles!engagements_advisor_id_fkey(full_name,email)',
        )
        .eq('firm_id', firmId!)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data as unknown as FirmEngagementRosterRow[]) ?? [];
    },
  });
}

// The firm's staff who can own an engagement (advisor/admin) — the assignment
// dropdown's options.
export interface FirmStaffRow {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
}

export function useFirmStaff(firmId: string | undefined | null): UseQueryResult<FirmStaffRow[]> {
  return useQuery({
    queryKey: qk.firmStaff(firmId ?? ''),
    enabled: !!firmId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id,full_name,email,role')
        .eq('firm_id', firmId!)
        .in('role', ['advisor', 'admin'])
        .order('full_name');
      if (error) throw new Error(error.message);
      return (data as FirmStaffRow[]) ?? [];
    },
  });
}
