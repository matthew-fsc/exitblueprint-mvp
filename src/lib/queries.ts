// Central data layer (F0): every server-state read goes through TanStack Query
// with keys from one registry, so pages never fetch ad hoc and cache
// invalidation is precise. Supabase/PostgREST is the transport; these hooks are
// the only place components touch it for reads.
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { invokeFunction, supabase } from './supabase';
import { loadRubric, type RubricData } from './rubric';

// ---- key registry ----------------------------------------------------------
export const qk = {
  firm: (id: string) => ['firm', id] as const,
  branding: (firmId: string) => ['branding', firmId] as const,
  companies: () => ['companies'] as const,
  company: (id: string) => ['company', id] as const,
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
  firedAdvisory: (engagementId: string) => ['firedAdvisory', engagementId] as const,
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
export interface PortfolioRow {
  engagementId: string;
  companyName: string;
  industry: string | null;
  status: string;
  latestDrs: number | null;
  latestTier: string | null;
  latestOri: number | null;
  latestAt: string | null;
  priorDrs: number | null;
  delta: number | null;
  points: { seq: number; drs: number; tier: string | null }[];
  openGaps: number;
  assessmentCount: number;
}

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
      const companyById = new Map((companies.data ?? []).map((c: CompanyRow) => [c.id, c]));
      const byEngagement = new Map<string, AssessmentRow[]>();
      for (const a of (assessments.data ?? []) as AssessmentRow[]) {
        const list = byEngagement.get(a.engagement_id) ?? [];
        list.push(a);
        byEngagement.set(a.engagement_id, list);
      }
      const openByEngagement = new Map<string, number>();
      for (const g of (gaps.data ?? []) as { engagement_id: string }[]) {
        openByEngagement.set(g.engagement_id, (openByEngagement.get(g.engagement_id) ?? 0) + 1);
      }

      return ((engagements.data ?? []) as EngagementRow[]).map((e) => {
        const list = (byEngagement.get(e.id) ?? []).sort((a, b) => a.sequence_number - b.sequence_number);
        const latest = list[list.length - 1] ?? null;
        const prior = list.length > 1 ? list[list.length - 2] : null;
        const company = companyById.get(e.company_id);
        const latestDrs = latest?.drs_score != null ? Number(latest.drs_score) : null;
        const priorDrs = prior?.drs_score != null ? Number(prior.drs_score) : null;
        return {
          engagementId: e.id,
          companyName: company?.name ?? '—',
          industry: company?.industry ?? null,
          status: e.status,
          latestDrs,
          latestTier: latest?.drs_tier ?? null,
          latestOri: latest?.ori_score != null ? Number(latest.ori_score) : null,
          latestAt: latest?.completed_at ?? null,
          priorDrs,
          delta: latestDrs != null && priorDrs != null ? Math.round((latestDrs - priorDrs) * 10) / 10 : null,
          points: list
            .filter((a) => a.drs_score != null)
            .map((a) => ({ seq: a.sequence_number, drs: Number(a.drs_score), tier: a.drs_tier })),
          openGaps: openByEngagement.get(e.id) ?? 0,
          assessmentCount: list.length,
        } satisfies PortfolioRow;
      });
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

// Playbook id -> name/phase, for grouping roadmap tasks into workstreams.
export function usePlaybooks(): UseQueryResult<Map<string, { name: string; phase: string | null }>> {
  return useQuery({
    queryKey: ['playbooks'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('playbooks').select('id,name,phase');
      if (error) throw new Error(error.message);
      return new Map((data ?? []).map((p: { id: string; name: string; phase: string | null }) => [p.id, { name: p.name, phase: p.phase }]));
    },
  });
}

// ---- advisory library ------------------------------------------------------
export type AdvisoryItemType = 'buyer_question' | 'initiative' | 'risk_flag';

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
