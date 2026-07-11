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
  rubric: (rubricVersionId: string) => ['rubric', rubricVersionId] as const,
  engineRubric: (rubricVersionId: string) => ['engineRubric', rubricVersionId] as const,
  answers: (assessmentId: string) => ['answers', assessmentId] as const,
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
