// Advisory Library firing engine. Reads the deterministic scores already
// persisted for an engagement's latest completed assessment and surfaces the
// catalog items whose governing score is at or below their score_trigger —
// the buyer questions that will get asked, the initiatives worth taking, and
// the risk flags diligence will find. Critical-first, like the roadmap.
//
// This is descriptive, not scoring: it reads sub_score_results / dimension_scores
// verbatim and never computes or adjusts a score. The DRS engine stays canonical.
import type pg from 'pg';

export type AdvisoryItemType = 'buyer_question' | 'initiative' | 'risk_flag' | 'education';

export interface FiredAdvisoryItem {
  id: string;
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
  score_trigger: number;
  source: string;
  // The live score that fired the item and what it was measured against.
  governing_code: string;
  governing_score: number;
}

export interface AdvisoryFireResult {
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

// Critical first, then high, med, low (enum storage order is not severity order).
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, med: 2, low: 3 };

export async function fireAdvisoryItems(
  db: pg.ClientBase,
  engagementId: string,
): Promise<AdvisoryFireResult> {
  const eng = (
    await db.query(`select id, firm_id from engagements where id = $1`, [engagementId])
  ).rows[0];
  if (!eng) throw new Error(`engagement ${engagementId} not found`);

  const assessment = (
    await db.query(
      `select id from assessments
       where engagement_id = $1 and status = 'completed'
       order by completed_at desc nulls last, created_at desc
       limit 1`,
      [engagementId],
    )
  ).rows[0];

  const empty: AdvisoryFireResult = {
    assessment_id: null,
    items: [],
    counts: { buyer_question: 0, initiative: 0, risk_flag: 0, critical: 0, high: 0 },
  };
  if (!assessment) return empty;

  // Live scores from the persisted result, keyed by code.
  const dimScores = new Map<string, number>(
    (
      await db.query(
        `select d.code, ds.score from dimension_scores ds
         join dimensions d on d.id = ds.dimension_id
         where ds.assessment_id = $1`,
        [assessment.id],
      )
    ).rows.map((r) => [r.code as string, Number(r.score)]),
  );
  const subScores = new Map<string, number>(
    (
      await db.query(
        `select s.code, ssr.points from sub_score_results ssr
         join sub_scores s on s.id = ssr.sub_score_id
         where ssr.assessment_id = $1`,
        [assessment.id],
      )
    ).rows.map((r) => [r.code as string, Number(r.points)]),
  );

  // Catalog visible to this engagement: the global system items plus this
  // firm's own advisor-authored items. (RLS enforces the same when read from
  // the client; the server reads with the service role, so scope explicitly.)
  const catalog = (
    await db.query(
      `select id, item_type, code, title, body, response_framework, data_needed,
              dimension_code, sub_score_code, severity, buyer_type, score_trigger, source
       from advisory_library_items
       where active = true and score_trigger is not null and item_type <> 'education'
         and (firm_id is null or firm_id = $1)`,
      [eng.firm_id],
    )
  ).rows;

  const fired: FiredAdvisoryItem[] = [];
  for (const it of catalog) {
    // A sub-score trigger is finer than a dimension trigger; prefer it when set.
    const governingCode: string | null = it.sub_score_code ?? it.dimension_code ?? null;
    if (!governingCode) continue;
    const score = it.sub_score_code
      ? subScores.get(it.sub_score_code)
      : dimScores.get(it.dimension_code);
    if (score == null) continue; // score not present (e.g. owner-readiness dim)
    if (score > it.score_trigger) continue;

    fired.push({
      id: it.id,
      item_type: it.item_type,
      code: it.code,
      title: it.title,
      body: it.body,
      response_framework: it.response_framework,
      data_needed: it.data_needed,
      dimension_code: it.dimension_code,
      sub_score_code: it.sub_score_code,
      severity: it.severity,
      buyer_type: it.buyer_type,
      score_trigger: Number(it.score_trigger),
      source: it.source,
      governing_code: governingCode,
      governing_score: score,
    });
  }

  // Critical first; within a severity, the lowest score (most urgent) first;
  // then a stable tiebreak on code so output is deterministic.
  fired.sort(
    (a, b) =>
      (SEV_RANK[a.severity ?? ''] ?? 9) - (SEV_RANK[b.severity ?? ''] ?? 9) ||
      a.governing_score - b.governing_score ||
      (a.code ?? '').localeCompare(b.code ?? ''),
  );

  const counts = {
    buyer_question: fired.filter((f) => f.item_type === 'buyer_question').length,
    initiative: fired.filter((f) => f.item_type === 'initiative').length,
    risk_flag: fired.filter((f) => f.item_type === 'risk_flag').length,
    critical: fired.filter((f) => f.severity === 'critical').length,
    high: fired.filter((f) => f.severity === 'high').length,
  };

  return { assessment_id: assessment.id, items: fired, counts };
}

export interface EducationModule {
  id: string;
  code: string | null;
  title: string;
  body: string;
  dimension_code: string | null;
  sub_score_code: string | null;
  score_trigger: number | null;
  source: string;
  sort_order: number;
  // "Recommended for you" — the item is tied to a live score that is at or below
  // its trigger (the same firing rule the advisory items use).
  recommended: boolean;
}

// Education pieces for the owner's Learn tab: every education advisory item
// visible to the engagement's firm (system + firm), each flagged recommended
// when its governing score has tripped its trigger. Untriggered pieces are
// always available but never "recommended". Descriptive — reads scores, never
// writes one.
export async function educationModules(
  db: pg.ClientBase,
  engagementId: string,
): Promise<{ assessment_id: string | null; modules: EducationModule[] }> {
  const eng = (
    await db.query(`select id, firm_id from engagements where id = $1`, [engagementId])
  ).rows[0];
  if (!eng) throw new Error(`engagement ${engagementId} not found`);

  const assessment = (
    await db.query(
      `select id from assessments where engagement_id = $1 and status = 'completed'
       order by completed_at desc nulls last, created_at desc limit 1`,
      [engagementId],
    )
  ).rows[0];

  // Education lives in the content_modules library ONLY (docs/06) — the single
  // education home. A module is "recommended" when its readiness area currently
  // has an open gap on the engagement (the deterministic gap state, no LLM),
  // replacing the old score-trigger flag the advisory-education rows carried.
  const openDims = new Set<string>();
  for (const r of (
    await db.query(
      `select distinct d.code
       from gaps g
       join gap_definitions gd on gd.id = g.gap_definition_id
       join dimensions d on d.id = gd.dimension_id
       where g.engagement_id = $1 and g.status in ('open', 'in_remediation')`,
      [engagementId],
    )
  ).rows)
    openDims.add(r.code);

  const rows = (
    await db.query(
      `select id, code, title, body_md, dimension_code, source
       from content_modules
       where firm_id is null or firm_id = $1
       order by title`,
      [eng.firm_id],
    )
  ).rows;

  const modules: EducationModule[] = rows.map((it) => ({
    id: it.id,
    code: it.code,
    title: it.title,
    body: it.body_md,
    dimension_code: it.dimension_code,
    sub_score_code: null,
    score_trigger: null,
    source: it.source,
    sort_order: 0,
    recommended: it.dimension_code != null && openDims.has(it.dimension_code),
  }));
  // Recommended first, then alphabetical.
  modules.sort(
    (a, b) => Number(b.recommended) - Number(a.recommended) || a.title.localeCompare(b.title),
  );

  return { assessment_id: assessment?.id ?? null, modules };
}
