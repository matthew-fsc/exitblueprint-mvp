// Parses the /seed CSVs and playbook markdown into typed structures.
// Single parse path shared by the seed script, the engine tests, and the dev
// verification page (the browser-safe csv-parse build works in Node too).
import { parse } from 'csv-parse/browser/esm/sync';
import type {
  DimensionDef,
  FormulaType,
  GapDef,
  GapSeverity,
  GapTrigger,
  QuestionDef,
  Rubric,
  ScoreGroup,
  SubScoreDef,
} from './scoring/types';

type Row = Record<string, string>;

function rows(csvText: string): Row[] {
  return parse(csvText, { columns: true, skip_empty_lines: true }) as Row[];
}

export function parseDimensions(csvText: string): DimensionDef[] {
  return rows(csvText).map((r) => ({
    code: r.code,
    name: r.name,
    scoreGroup: r.score_group as ScoreGroup,
    drsWeight: Number(r.drs_weight),
    sortOrder: Number(r.sort_order),
  }));
}

export function parseQuestions(csvText: string): QuestionDef[] {
  return rows(csvText).map((r) => ({
    code: r.code,
    dimensionCode: r.dimension_code,
    prompt: r.prompt,
    answerType: r.answer_type,
    options: r.options || null,
    scored: r.scored === 'True' || r.scored === 'true',
    sortOrder: Number(r.sort_order),
  }));
}

export function parseSubScores(csvText: string): SubScoreDef[] {
  return rows(csvText).map((r) => ({
    code: r.code,
    dimensionCode: r.dimension_code,
    name: r.name,
    weight: Number(r.weight),
    formulaType: r.formula_type as FormulaType,
    inputQuestionCodes: r.input_question_codes.split(',').map((s) => s.trim()),
    logic: JSON.parse(r.logic_json),
    notes: r.notes || null,
  }));
}

export function parseGapDefinitions(csvText: string): GapDef[] {
  return rows(csvText).map((r) => ({
    code: r.code,
    name: r.name,
    severity: r.severity as GapSeverity,
    dimensionCode: r.dimension_code,
    trigger: JSON.parse(r.trigger_json) as GapTrigger,
  }));
}

export interface ContentModuleSeed {
  code: string;
  title: string;
  dimensionCode: string;
  body: string;
}

export function parseContentModules(csvText: string): ContentModuleSeed[] {
  return rows(csvText).map((r) => ({
    code: r.code,
    title: r.title,
    dimensionCode: r.dimension_code,
    body: r.body,
  }));
}

export interface AdvisoryItemSeed {
  code: string;
  itemType: 'buyer_question' | 'initiative' | 'risk_flag';
  title: string;
  body: string;
  responseFramework: string | null;
  dataNeeded: string | null;
  dimensionCode: string | null;
  subScoreCode: string | null;
  severity: GapSeverity | null;
  buyerType: string | null;
  scoreTrigger: number | null;
  sortOrder: number;
}

export function parseAdvisoryLibrary(csvText: string): AdvisoryItemSeed[] {
  return rows(csvText).map((r) => ({
    code: r.code,
    itemType: r.item_type as AdvisoryItemSeed['itemType'],
    title: r.title,
    body: r.body,
    responseFramework: r.response_framework || null,
    dataNeeded: r.data_needed || null,
    dimensionCode: r.dimension_code || null,
    subScoreCode: r.sub_score_code || null,
    severity: (r.severity as GapSeverity) || null,
    buyerType: r.buyer_type || null,
    scoreTrigger: r.score_trigger === '' || r.score_trigger == null ? null : Number(r.score_trigger),
    sortOrder: r.sort_order ? Number(r.sort_order) : 0,
  }));
}

export interface ValuationMultipleSeed {
  industryKey: string;
  sizeBand: string;
  baseMultiple: number;
}

export function parseValuationMultiples(csvText: string): ValuationMultipleSeed[] {
  return rows(csvText).map((r) => ({
    industryKey: r.industry_key,
    sizeBand: r.size_band,
    baseMultiple: Number(r.base_multiple),
  }));
}

export interface CodeMapSeed {
  fromCode: string;
  toCode: string;
  order: number;
}

export function parseGapPlaybookMap(csvText: string): CodeMapSeed[] {
  return rows(csvText).map((r) => ({
    fromCode: r.gap_code,
    toCode: r.playbook_code,
    order: Number(r.priority),
  }));
}

export function parseGapContentMap(csvText: string): CodeMapSeed[] {
  return rows(csvText).map((r) => ({
    fromCode: r.gap_code,
    toCode: r.content_code,
    order: Number(r.drip_order),
  }));
}

export interface PlaybookSeed {
  code: string;
  name: string;
  version: number;
  dimensionCode: string;
  phase: string;
  evImpact: string;
  summary: string;
  bodyMd: string;
  tasks: { sequence: number; title: string; ownerRole: string; offsetDays: number }[];
}

export function parsePlaybook(md: string): PlaybookSeed {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) throw new Error('playbook missing frontmatter');
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const tasks = [...md.matchAll(/^\|\s*(\d+)\s*\|(.+?)\|(.+?)\|\s*(\d+)\s*\|\s*$/gm)].map((m) => ({
    sequence: Number(m[1]),
    title: m[2].trim(),
    ownerRole: m[3].trim(),
    offsetDays: Number(m[4]),
  }));
  return {
    code: fm.code,
    name: fm.name,
    version: Number(fm.version ?? 1),
    dimensionCode: fm.dimension,
    phase: fm.phase,
    evImpact: fm.ev_impact,
    summary: fm.summary,
    bodyMd: md.slice(fmMatch[0].length),
    tasks,
  };
}

export function buildRubric(csv: {
  dimensions: string;
  questions: string;
  subScores: string;
  gapDefinitions: string;
}): Rubric {
  return {
    dimensions: parseDimensions(csv.dimensions),
    questions: parseQuestions(csv.questions),
    subScores: parseSubScores(csv.subScores),
    gapDefinitions: parseGapDefinitions(csv.gapDefinitions),
  };
}

/** Referential integrity of the seed set; returns human-readable problems. */
export function validateRubric(rubric: Rubric, playbooks: PlaybookSeed[],
  contentModules: ContentModuleSeed[], gapPlaybookMap: CodeMapSeed[],
  gapContentMap: CodeMapSeed[]): string[] {
  const problems: string[] = [];
  const dimCodes = new Set(rubric.dimensions.map((d) => d.code));
  const questionCodes = new Set(rubric.questions.map((q) => q.code));
  const subScoreCodes = new Set(rubric.subScores.map((s) => s.code));
  const gapCodes = new Set(rubric.gapDefinitions.map((g) => g.code));
  const playbookCodes = new Set(playbooks.map((p) => p.code));
  const contentCodes = new Set(contentModules.map((c) => c.code));

  for (const q of rubric.questions) {
    if (!dimCodes.has(q.dimensionCode)) problems.push(`question ${q.code}: unknown dimension ${q.dimensionCode}`);
  }
  for (const s of rubric.subScores) {
    if (!dimCodes.has(s.dimensionCode)) problems.push(`sub_score ${s.code}: unknown dimension ${s.dimensionCode}`);
    for (const qc of s.inputQuestionCodes) {
      if (!questionCodes.has(qc)) problems.push(`sub_score ${s.code}: unknown input question ${qc}`);
    }
  }
  const checkTrigger = (gapCode: string, t: GapTrigger) => {
    if (t.type === 'sub_score_below' && !subScoreCodes.has(t.code)) {
      problems.push(`gap ${gapCode}: unknown sub_score ${t.code}`);
    }
    if ((t.type === 'answer_in' || t.type === 'answer_lte') && !questionCodes.has(t.question_code)) {
      problems.push(`gap ${gapCode}: unknown question ${t.question_code}`);
    }
    if (t.type === 'all') t.conditions.forEach((c) => checkTrigger(gapCode, c));
  };
  for (const g of rubric.gapDefinitions) {
    if (!dimCodes.has(g.dimensionCode)) problems.push(`gap ${g.code}: unknown dimension ${g.dimensionCode}`);
    checkTrigger(g.code, g.trigger);
  }
  for (const m of gapPlaybookMap) {
    if (!gapCodes.has(m.fromCode)) problems.push(`gap_playbook_map: unknown gap ${m.fromCode}`);
    if (!playbookCodes.has(m.toCode)) problems.push(`gap_playbook_map: unknown playbook ${m.toCode}`);
  }
  for (const m of gapContentMap) {
    if (!gapCodes.has(m.fromCode)) problems.push(`gap_content_map: unknown gap ${m.fromCode}`);
    if (!contentCodes.has(m.toCode)) problems.push(`gap_content_map: unknown content module ${m.toCode}`);
  }
  // Sub-score weights must sum to 1.0 per business dimension; ORI weights sum
  // to 1.0 across the owner_readiness group as a whole (reference scorer).
  for (const d of rubric.dimensions.filter((d) => d.scoreGroup === 'business_readiness')) {
    const sum = rubric.subScores
      .filter((s) => s.dimensionCode === d.code)
      .reduce((acc, s) => acc + s.weight, 0);
    if (Math.abs(sum - 1) > 1e-9) problems.push(`dimension ${d.code}: sub-score weights sum to ${sum}, expected 1.0`);
  }
  const oriDims = new Set(rubric.dimensions.filter((d) => d.scoreGroup === 'owner_readiness').map((d) => d.code));
  const oriSum = rubric.subScores
    .filter((s) => oriDims.has(s.dimensionCode))
    .reduce((acc, s) => acc + s.weight, 0);
  if (oriSum > 0 && Math.abs(oriSum - 1) > 1e-9) problems.push(`ORI sub-score weights sum to ${oriSum}, expected 1.0`);
  return problems;
}
