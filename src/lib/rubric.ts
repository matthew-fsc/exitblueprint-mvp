import { supabase } from './supabase';

export interface DimensionRow {
  id: string;
  code: string;
  name: string;
  score_group: 'business_readiness' | 'owner_readiness';
  drs_weight: number;
  sort_order: number;
}

export interface QuestionRow {
  id: string;
  dimension_id: string;
  code: string;
  prompt: string;
  help_text: string | null;
  answer_type:
    | 'numeric'
    | 'numeric_list'
    | 'numeric_or_unknown'
    | 'select'
    | 'scale_1_5'
    | 'rank'
    | 'text';
  options: string | null;
  scored: boolean;
  sort_order: number;
}

export interface RubricData {
  rubricVersionId: string;
  versionLabel: string;
  dimensions: DimensionRow[];
  questionsByDimension: Map<string, QuestionRow[]>;
}

export async function loadActiveRubricVersion(): Promise<{ id: string; version_label: string }> {
  const { data, error } = await supabase
    .from('rubric_versions')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error('no active rubric version — run npm run db:seed');
  return data[0];
}

export async function loadRubric(rubricVersionId: string): Promise<RubricData> {
  const { data: version, error: vErr } = await supabase
    .from('rubric_versions')
    .select('*')
    .eq('id', rubricVersionId)
    .single();
  if (vErr) throw new Error(vErr.message);
  const { data: dims, error: dErr } = await supabase
    .from('dimensions')
    .select('*')
    .eq('rubric_version_id', rubricVersionId)
    .order('sort_order');
  if (dErr) throw new Error(dErr.message);
  const dimensions = (dims ?? []) as DimensionRow[];
  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('*')
    .in('dimension_id', dimensions.map((d) => d.id))
    .order('sort_order');
  if (qErr) throw new Error(qErr.message);
  const questionsByDimension = new Map<string, QuestionRow[]>();
  for (const d of dimensions) questionsByDimension.set(d.id, []);
  for (const q of (questions ?? []) as QuestionRow[]) {
    questionsByDimension.get(q.dimension_id)?.push(q);
  }
  return {
    rubricVersionId,
    versionLabel: version.version_label,
    dimensions,
    questionsByDimension,
  };
}
