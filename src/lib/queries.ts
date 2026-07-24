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
  companies: () => ['companies'] as const,
  company: (id: string) => ['company', id] as const,
  agreementVersions: () => ['agreementVersions'] as const,
  sourceDocuments: (engagementId: string) => ['sourceDocuments', engagementId] as const,
  dataRoom: (engagementId: string) => ['dataRoom', engagementId] as const,
  evidenceCoverage: (engagementId: string) => ['evidenceCoverage', engagementId] as const,
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
  diligenceSimulation: (engagementId: string) => ['diligenceSimulation', engagementId] as const,
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
  buyers: (firmId: string) => ['buyers', firmId] as const,
  buyerMandates: (buyerId: string) => ['buyerMandates', buyerId] as const,
  buyerMatches: (engagementId: string) => ['buyerMatches', engagementId] as const,
  marketContext: (engagementId: string) => ['marketContext', engagementId] as const,
  diligenceQa: (engagementId: string) => ['diligenceQa', engagementId] as const,
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
  reassessment_interval_days: number | null;
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

// Evidence binder coverage: the single "diligence binder" figure for an
// engagement — of the applicable request-list items, how many are PROVEN (marked
// Ready AND backed by a verified document). This is the Evidence masthead
// headline; distinct from data-room readiness_pct (self-reported Ready) and from
// the assessment-scoped financial verification summary. Read-only.
export interface EvidenceCoverageShape {
  total: number;
  ready: number;
  verified: number;
  pct: number;
}

export function useEvidenceCoverage(
  engagementId: string | undefined,
): UseQueryResult<EvidenceCoverageShape> {
  return useQuery({
    queryKey: qk.evidenceCoverage(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: () =>
      invokeFunction<EvidenceCoverageShape>('evidence-coverage', { engagement_id: engagementId }),
  });
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
  // The remediation Plan this gap is linked to (gap_plan_map) — the "roadmap
  // initiative" that addresses it.
  remediationName: string | null;
  remediationSummary: string | null;
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
      const [gaps, defs, maps, plans] = await Promise.all([
        supabase
          .from('gaps')
          .select('*')
          .eq('engagement_id', engagementId!)
          .in('status', ['open', 'in_remediation']),
        supabase.from('gap_definitions').select('*').eq('rubric_version_id', rubricVersionId!),
        supabase.from('gap_plan_map').select('*'),
        supabase.from('plan_templates').select('id,name,summary'),
      ]);
      for (const r of [gaps, defs, maps, plans]) if (r.error) throw new Error(r.error.message);
      const defById = new Map((defs.data ?? []).map((d: { id: string; code: string; name: string; severity: string }) => [d.id, d]));
      const planById = new Map((plans.data ?? []).map((p: { id: string; name: string; summary: string }) => [p.id, p]));
      const planByGapDef = new Map<string, { name: string; summary: string }>();
      for (const m of (maps.data ?? []) as { gap_definition_id: string; plan_template_id: string }[]) {
        const pl = planById.get(m.plan_template_id);
        if (pl && !planByGapDef.has(m.gap_definition_id)) planByGapDef.set(m.gap_definition_id, pl);
      }
      const severityRank: Record<string, number> = { critical: 0, high: 1, med: 2, low: 3 };
      return ((gaps.data ?? []) as { id: string; gap_definition_id: string; status: string }[])
        .map((g) => {
          const def = defById.get(g.gap_definition_id);
          const pl = def ? planByGapDef.get(g.gap_definition_id) : null;
          return {
            id: g.id,
            code: def?.code ?? '',
            name: def?.name ?? 'Unknown gap',
            severity: (def?.severity ?? 'med') as EngagementGap['severity'],
            status: g.status,
            remediationName: pl?.name ?? null,
            remediationSummary: pl?.summary ?? null,
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

// ---- buyer matching (buyer-matching design doc) ----------------------------------------------
// The firm's OWN book of buyers + their versioned acquisition mandates, and the
// deterministic ranked matches for an engagement. Buyers/mandates are read
// directly (RLS-scoped, staff-writable); matches come from the rules engine.
export type BuyerKind =
  | 'strategic' | 'financial_sponsor' | 'family_office' | 'search_fund'
  | 'individual' | 'strategic_competitor' | 'esop_internal';

export interface BuyerRow {
  id: string;
  name: string;
  organization: string | null;
  buyer_kind: BuyerKind;
  relationship_strength: 'strong' | 'moderate' | 'weak' | 'unknown';
  status: 'active' | 'dormant' | 'acquired_recently' | 'do_not_contact';
  contact_name: string | null;
  contact_email: string | null;
  notes: string | null;
  created_at: string;
}

export interface BuyerMandateRow {
  id: string;
  buyer_id: string;
  mandate_version: number;
  label: string | null;
  target_industries: string[];
  target_revenue_bands: string[];
  target_ebitda_bands: string[];
  target_states: string[];
  deal_structures: string[];
  must_haves: string[];
  dealbreaker_gap_codes: string[];
  min_drs: number | null;
  status: 'active' | 'retired';
  notes: string | null;
}

export interface BuyerMatchRow {
  buyerId: string;
  buyerName: string;
  buyerKind: BuyerKind;
  relationshipStrength: string;
  mandateId: string;
  mandateVersion: number;
  score: number;
  blocked: boolean;
  factors: string[];
  blockers: string[];
}

export interface BuyerMatchSubjectShape {
  industry: string | null;
  revenueBand: string | null;
  ebitdaBand: string | null;
  state: string | null;
  drs: number | null;
  openGapCodes: string[];
}

export function useBuyers(firmId: string | undefined | null): UseQueryResult<BuyerRow[]> {
  return useQuery({
    queryKey: qk.buyers(firmId ?? ''),
    enabled: !!firmId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('buyers')
        .select('id,name,organization,buyer_kind,relationship_strength,status,contact_name,contact_email,notes,created_at')
        .eq('firm_id', firmId!)
        .eq('archived', false)
        .order('name');
      if (error) throw new Error(error.message);
      return (data as BuyerRow[]) ?? [];
    },
  });
}

export function useBuyerMandates(buyerId: string | undefined | null): UseQueryResult<BuyerMandateRow[]> {
  return useQuery({
    queryKey: qk.buyerMandates(buyerId ?? ''),
    enabled: !!buyerId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('buyer_mandates')
        .select('id,buyer_id,mandate_version,label,target_industries,target_revenue_bands,target_ebitda_bands,target_states,deal_structures,must_haves,dealbreaker_gap_codes,min_drs,status,notes')
        .eq('buyer_id', buyerId!)
        .order('mandate_version', { ascending: false });
      if (error) throw new Error(error.message);
      return (data as BuyerMandateRow[]) ?? [];
    },
  });
}

export function useEngagementBuyerMatches(
  engagementId: string | undefined,
): UseQueryResult<{ subject: BuyerMatchSubjectShape; matches: BuyerMatchRow[] }> {
  return useQuery({
    queryKey: engagementId ? qk.buyerMatches(engagementId) : ['buyerMatches', ''],
    enabled: !!engagementId,
    queryFn: () =>
      invokeFunction<{ subject: BuyerMatchSubjectShape; matches: BuyerMatchRow[] }>(
        'engagement-buyer-matches',
        { engagement_id: engagementId },
      ),
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
  // The library task this row was instantiated/claimed from (null for inline
  // manual tasks). The once-per-engagement idempotency key.
  library_task_id: string | null;
  // The applied Plan (engagement_plans.id) this task belongs to, when it was
  // laid down or claimed by a Plan; null for manual tasks.
  engagement_plan_id: string | null;
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
  // The applied Plan this milestone belongs to; null for advisor-added ones.
  engagement_plan_id: string | null;
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

// Library task id -> descriptive metadata, for annotating the Plan authoring
// task picker (title / dimension).
export interface LibraryTaskMeta {
  title: string;
  dimension_code: string | null;
}
export function useLibraryTasks(): UseQueryResult<Map<string, LibraryTaskMeta>> {
  return useQuery({
    queryKey: ['library-tasks'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('library_tasks').select('id,title,dimension_code');
      if (error) throw new Error(error.message);
      return new Map(
        (data ?? []).map((t: { id: string } & LibraryTaskMeta) => [
          t.id,
          { title: t.title, dimension_code: t.dimension_code },
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

// ---- diligence simulation --------------------------------------------------
// The proactive buyer lens: a persisted, ranked blind-spot report built on top of
// the institutional reviewer. Findings and their severity are deterministic
// (server-side); the narrative is draft prose.
export type DiligenceSourceKind = 'gap' | 'evidence' | 'buyer_question' | 'untracked';
export type DiligenceSeverity = 'critical' | 'high' | 'med' | 'low';

export interface DiligenceRemediation {
  kind: 'plan' | 'library' | 'evidence' | 'roadmap';
  label: string;
  ref: string | null;
}

export interface DiligenceFinding {
  rank: number;
  severity: DiligenceSeverity;
  area: string;
  source_kind: DiligenceSourceKind;
  title: string;
  why: string;
  remediation: DiligenceRemediation | null;
}

export interface DiligenceRunView {
  id: string;
  created_at: string;
  prompt_version: string;
  model: string;
  is_draft: true;
  narrative_md: string;
  finding_count: number;
  company: { name: string; industry: string | null };
  band: string;
  overall_score: number;
  owner_readiness_index: number;
  findings: DiligenceFinding[];
}

export interface DiligenceRunResult {
  assessment_id: string | null;
  run: DiligenceRunView | null;
}

// The latest persisted simulation run for an engagement (read-only). Triggering a
// new run is a direct invokeFunction('simulate-diligence', ...) from the page,
// which then invalidates this query.
export function useDiligenceSimulation(
  engagementId: string | undefined,
): UseQueryResult<DiligenceRunResult> {
  return useQuery({
    queryKey: qk.diligenceSimulation(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: () =>
      invokeFunction<DiligenceRunResult>('diligence-simulation', { engagement_id: engagementId }),
  });
}

// ---- market context (docs/sellside-ai/01) ----------------------------------
// Cited market-reference passages (sector commentary, precedent transactions)
// for the engagement's industry/size, retrieved from the non-tenant `market`
// schema. Every passage carries a human `citation` + a short `cite_id`, so the
// UI can render the source next to any figure it shows (the source-score
// contract). Reference/context only — no scoring, no LLM in the retrieval loop.
export interface MarketPassage {
  body: string;
  cite_id: string;
  citation: string;
  dataset: string;
  as_of: string | null;
  kind: string;
}

export interface MarketContextResult {
  passages: MarketPassage[];
}

export function useMarketContext(
  engagementId: string | undefined,
): UseQueryResult<MarketContextResult> {
  return useQuery({
    queryKey: qk.marketContext(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: () =>
      invokeFunction<MarketContextResult>('retrieve-market-context', {
        engagement_id: engagementId,
      }),
  });
}

// ---- diligence Q&A (docs/sellside-ai/05 §4) --------------------------------
// Advisor-reviewed draft answers to buyer diligence questions, grounded in the
// engagement's OWN verified facts / data room / findings. Every claim carries a
// citation (the source-score contract). `mode` distinguishes an AI-synthesized
// draft from the RETRIEVAL-ONLY graceful-degradation fallback (AI call failed /
// no credit): the UI must make that distinction visible. Answers are written by
// the answer-diligence-question function (WRITE, gated) and read back here.
export interface EvidenceRef {
  cite_id: string;
  citation: string;
  body: string;
  source: 'verified_fact' | 'data_room' | 'gap' | 'advisory' | 'market';
}

export interface DiligenceQa {
  id: string;
  question: string;
  answer_md: string;
  mode: 'ai' | 'retrieval_only';
  model: string;
  prompt_version: string;
  evidence: EvidenceRef[];
  created_at: string;
}

export function useDiligenceQaList(
  engagementId: string | undefined,
): UseQueryResult<{ items: DiligenceQa[] }> {
  return useQuery({
    queryKey: qk.diligenceQa(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: () =>
      invokeFunction<{ items: DiligenceQa[] }>('list-diligence-qa', {
        engagement_id: engagementId,
      }),
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

// Which answers have a STORED evidence document behind their provenance
// (question_id -> evidence_document_id | null). Additive to useAnswerProvenance:
// lets the UI show that a verified financial answer is backed by a real file,
// not just attested. A `document` row with a null value here is legacy/unbacked.
export function useAnswerEvidence(
  assessmentId: string | undefined,
): UseQueryResult<Record<string, string | null>> {
  return useQuery({
    queryKey: ['answerEvidence', assessmentId ?? ''],
    enabled: !!assessmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('answer_provenance')
        .select('question_id,evidence_document_id')
        .eq('assessment_id', assessmentId!);
      if (error) throw new Error(error.message);
      return Object.fromEntries(
        (data ?? []).map((r: { question_id: string; evidence_document_id: string | null }) => [
          r.question_id,
          r.evidence_document_id,
        ]),
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
  multiple_source: 'table' | 'override' | 'own_book' | 'market';
  // Own-book (moat 2) and licensed-market reference multiples are shown ALONGSIDE
  // the table multiple; either drives only when a valuation_rules_version elects
  // it (own_book_driving / multiple_source === 'market'). The market lane is
  // reference-only today (docs/sellside-ai/01), so market_* populate whenever the
  // firm's sector has seeded market data even when 'market' is not the source.
  own_book_sample_size: number | null;
  own_book_same_band: number | null;
  own_book_multiple: number | null;
  own_book_p25: number | null;
  own_book_p75: number | null;
  own_book_confidence: 'low' | 'moderate' | 'high' | null;
  own_book_driving: boolean;
  market_multiple: number | null; // median from licensed/placeholder market comps
  market_p25: number | null;
  market_p75: number | null;
  market_sample_size: number | null;
  market_source: string | null; // 'market' only when it drives the base multiple
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

// ── Plans (docs/37) ──────────────────────────────────────────────────────────
export type PlanItemKind = 'task' | 'education' | 'advisory' | 'milestone' | 'manual_task';

export interface PlanItemView {
  id: string;
  item_kind: PlanItemKind;
  library_task_id: string | null;
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

// Score-driven Plan recommendations for an engagement (docs/37 Q5) — surfaced
// from open gaps AND fired initiatives, ranked by combined coverage.
export interface PlanRecommendationRow {
  plan_template_id: string;
  name: string;
  is_system: boolean;
  matched_gap_count: number;
  matched_gap_codes: string[];
  matched_initiative_count: number;
  matched_initiative_titles: string[];
  match_score: number;
}

// generate-roadmap result: gap-derived tasks created + the substantively-
// applicable Plans it auto-applied (docs/37 Q5b).
export interface AutoAppliedPlanSummary {
  plan_template_id: string;
  name: string;
  tasks_created: number;
  tasks_claimed: number;
  milestones_created: number;
}
export interface GenerateRoadmapResult {
  tasksCreated: number;
  plansApplied: AutoAppliedPlanSummary[];
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

// ---- firm-authorable library tasks & content modules (docs/37 unify) -------
// System rows (firm_id null) are shared methodology; firm rows (source 'advisor')
// are the firm's own, editable by its staff. Both are returned so the Library
// catalog and the Plan builder show them together.
export interface LibraryTaskCatalogRow {
  id: string;
  firm_id: string | null;
  source: string;
  code: string | null;
  title: string;
  description: string | null;
  default_owner_role: string;
  dimension_code: string | null;
  target_offset_days: number | null;
}

export const qkLibraryTaskCatalog = ['library-task-catalog'] as const;

export function useLibraryTaskCatalog(): UseQueryResult<LibraryTaskCatalogRow[]> {
  return useQuery({
    queryKey: qkLibraryTaskCatalog,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('library_tasks')
        .select('id,firm_id,source,code,title,description,default_owner_role,dimension_code,target_offset_days')
        .order('title', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as LibraryTaskCatalogRow[];
    },
  });
}

export interface ContentModuleCatalogRow {
  id: string;
  firm_id: string | null;
  source: string;
  code: string;
  title: string;
  dimension_code: string | null;
  body_md: string | null;
}

export const qkContentModuleCatalog = ['content-module-catalog'] as const;

export function useContentModuleCatalog(): UseQueryResult<ContentModuleCatalogRow[]> {
  return useQuery({
    queryKey: qkContentModuleCatalog,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('content_modules')
        .select('id,firm_id,source,code,title,dimension_code,body_md')
        .order('title', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as ContentModuleCatalogRow[];
    },
  });
}

// ---- engagement comments (collaboration thread; 20260721001500) ------------
export interface EngagementCommentRow {
  id: string;
  created_at: string;
  engagement_id: string;
  author_profile_id: string | null;
  author_name: string | null;
  author_role: string | null;
  body: string;
}

export const qkEngagementComments = (engagementId: string) => ['engagement-comments', engagementId] as const;

export function useEngagementComments(engagementId: string | undefined): UseQueryResult<EngagementCommentRow[]> {
  return useQuery({
    queryKey: qkEngagementComments(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagement_comments')
        .select('id,created_at,engagement_id,author_profile_id,author_name,author_role,body')
        .eq('engagement_id', engagementId!)
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as EngagementCommentRow[];
    },
  });
}
