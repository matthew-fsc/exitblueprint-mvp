// Narrative service (docs/04): generateDocument(assessment_id, doc_type).
// Claude writes prose FROM structured data — computed scores, gap names, the
// explain trace, precomputed deltas. It never writes to scoring tables and
// never computes a number (CLAUDE.md rule 2). Server-side only: the API key
// is read from the server environment, never shipped to the client.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { compareAssessments, explainAssessment } from './scoring';
import type { ExplainResult } from '../shared/scoring/engine';
import { gapReason, interpretSubScore, tierMeaning } from '../shared/scoring/interpret';
import { buildCimPayload, composeCim } from './cim';

const PROMPT_VERSION = 'owner_report.v1';
const MODEL = 'claude-opus-4-8';
// Model label stored on documents written by the deterministic composer, so a
// reader can always tell a rule-based report from an AI-drafted one.
const RULE_BASED_MODEL = 'rule-based:owner_report.v1';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface GeneratedText {
  text: string;
  model: string;
}

// Injectable for tests; the default calls the Claude API.
export type GenerateFn = (systemPrompt: string, userContent: string) => Promise<GeneratedText>;

async function callClaude(systemPrompt: string, userContent: string): Promise<GeneratedText> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'narrative service not configured: set ANTHROPIC_API_KEY in the server environment',
    );
  }
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) throw new Error(`narrative generation returned no text (${response.stop_reason})`);
  return { text, model: response.model };
}

// --- Payload (the only numbers the model may use) ------------------------------

export async function buildOwnerReportPayload(db: pg.ClientBase, assessmentId: string) {
  const assessment = (
    await db.query(
      `select a.*, e.company_id, e.target_exit_window
       from active_assessments a join engagements e on e.id = a.engagement_id
       where a.id = $1 and a.status = 'completed'`,
      [assessmentId],
    )
  ).rows[0];
  if (!assessment) throw new Error(`assessment ${assessmentId} not found, not completed, or superseded`);

  const company = (
    await db.query(`select name, industry from companies where id = $1`, [assessment.company_id])
  ).rows[0];

  const explain = await explainAssessment(db, assessmentId);

  // Top gaps (max 5) by severity, with mapped playbook summaries.
  const severityRank: Record<string, number> = { critical: 0, high: 1, med: 2, low: 3 };
  const topGaps = [...explain.firedGaps]
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9))
    .slice(0, 5);
  const playbooks = await db.query(
    `select gd.code as gap_code, p.name, p.summary
     from gap_definitions gd
     join gap_playbook_map m on m.gap_definition_id = gd.id
     join playbooks p on p.id = m.playbook_id
     where gd.code = any($1) and gd.rubric_version_id = $2
     order by m.priority`,
    [topGaps.map((g) => g.code), assessment.rubric_version_id],
  );

  // Precomputed delta vs the prior active completed assessment (S4.5 A3/B2):
  // the server computes every derived figure; the model never does arithmetic.
  const prior = (
    await db.query(
      `select id from active_assessments
       where engagement_id = $1 and status = 'completed' and sequence_number < $2
       order by sequence_number desc limit 1`,
      [assessment.engagement_id, assessment.sequence_number],
    )
  ).rows[0];
  const comparison = prior ? await compareAssessments(db, prior.id, assessmentId) : null;

  return {
    company: { name: company.name, industry: company.industry },
    engagement_target_window: assessment.target_exit_window,
    overall_score: explain.drsScore,
    band: explain.drsTier,
    owner_readiness_index: explain.oriScore,
    dimensions: explain.dimensions.map((d) => ({
      name: d.name,
      score: d.score,
      meaning: `Weighted ${d.drsWeight} of the overall score`,
    })),
    top_gaps: topGaps.map((g) => ({
      name: g.name,
      severity: g.severity,
      playbook: playbooks.rows.find((p) => p.gap_code === g.code)?.summary ?? null,
    })),
    flags: explain.flags,
    prior_comparison: comparison === null
      ? null
      : comparison.comparable
        ? {
            comparable: true,
            drs_delta: comparison.drsDelta,
            prior_drs: comparison.prior.drsScore,
            prior_tier: comparison.prior.drsTier,
            gaps_resolved: comparison.gapsResolved,
            gaps_opened: comparison.gapsOpened,
          }
        : { comparable: false, reason: comparison.reason },
  };
}

// --- Numeral post-check (docs/04, amended S4.5 B2) ------------------------------
// Strict: every numeral in the output must appear in the input payload.
// Whitelist: years, markdown list numbering, and numbers present in the payload.

const NUMERAL = /\d+(?:\.\d+)?/g;

export function numeralPostCheck(outputMd: string, payload: unknown): string[] {
  const allowed = new Set<string>(JSON.stringify(payload).match(NUMERAL) ?? []);
  const violations: string[] = [];
  for (const line of outputMd.split('\n')) {
    // markdown list numbering ("1. ..." / "2) ...") is whitelisted
    const body = line.replace(/^\s*\d+[.)]\s/, '');
    for (const numeral of body.match(NUMERAL) ?? []) {
      if (allowed.has(numeral)) continue;
      if (/^(19|20)\d{2}$/.test(numeral)) continue; // years
      violations.push(numeral);
    }
  }
  return [...new Set(violations)];
}

// --- Deterministic composer (no API key required) -------------------------------
// Rule-based narrative assembled from the same explain trace and gap set the
// scorer produced. This is the CLAUDE.md rule-1/rule-2-safe path: it computes
// nothing new and invents nothing — it only phrases the deterministic output,
// so it is always available (demos, environments without an Anthropic key) and
// fully defensible. The premise is identical to the AI path: what the score is,
// what flags fired, why, and what the fix is.

type OwnerReportPayload = Awaited<ReturnType<typeof buildOwnerReportPayload>>;

const WHY_BUYERS_CARE: Record<string, string> = {
  critical: 'On its own this can stall a deal or force a real price cut, so it comes first.',
  high: 'Buyers weight this heavily in diligence, so resolving it protects both price and certainty.',
  med: 'It is a common diligence question; getting ahead of it keeps the process smooth.',
  low: 'It is a smaller item, worth clearing so nothing avoidable surfaces late.',
};

export function composeOwnerReport(
  payload: OwnerReportPayload,
  explain: ExplainResult,
): string {
  const { company } = payload;
  const subScoreNames = new Map(explain.subScores.map((s) => [s.code, s.name]));
  const readingByDim = new Map<string, ReturnType<typeof interpretSubScore>[]>();
  for (const s of explain.subScores) {
    const list = readingByDim.get(s.dimensionCode) ?? [];
    list.push(interpretSubScore(s));
    readingByDim.set(s.dimensionCode, list);
  }

  const lines: string[] = [];
  lines.push(`# Exit Readiness Report — ${company.name}`);
  lines.push('');
  lines.push(
    `_This report is built directly from your assessment answers. Every figure traces back to what you reported; nothing here is estimated or assumed._`,
  );
  lines.push('');

  // Where the business stands.
  lines.push('## Where the business stands');
  lines.push(
    `Your Diligence Readiness Score is ${payload.overall_score}, which places ${company.name} in the ${payload.band} tier. In plain terms, ${tierMeaning(payload.band)}.`,
  );
  const gap = Math.abs(payload.overall_score - payload.owner_readiness_index);
  lines.push(
    gap >= 15
      ? `Your Owner Readiness Index is ${payload.owner_readiness_index}, measured separately from the business score. The two are far apart, which is itself worth noting: the business and your personal readiness are at different stages, and the plan should close both.`
      : `Your Owner Readiness Index is ${payload.owner_readiness_index}, measured separately. The business and your personal readiness are broadly aligned.`,
  );
  lines.push('');

  // Strengths — the two highest business dimensions.
  const ranked = [...explain.dimensions].sort((a, b) => b.score - a.score);
  lines.push('## What is working');
  for (const d of ranked.slice(0, 2)) {
    const best = (readingByDim.get(d.code) ?? []).sort((a, b) => b.points - a.points)[0];
    const detail = best ? ` In particular: ${best.reading.replace(/\.$/, '')}.` : '';
    lines.push(`- **${d.name}** scored ${d.score}, among the strongest parts of the business.${detail}`);
  }
  lines.push('');

  // Priority issues — the flagged gaps, in severity order.
  lines.push('## What to fix first');
  if (payload.top_gaps.length === 0) {
    lines.push('No gaps were flagged in this assessment. The focus shifts to holding the score and preparing materials.');
  } else {
    for (const g of payload.top_gaps) {
      lines.push(`### ${g.name}`);
      const why = WHY_BUYERS_CARE[g.severity] ?? WHY_BUYERS_CARE.med;
      lines.push(`This was flagged as a ${g.severity} priority. ${why}`);
      if (g.playbook) lines.push(`What the fix looks like: ${g.playbook}`);
      lines.push('');
    }
  }

  // Not-tracked flags, if any.
  if (payload.flags.length > 0) {
    lines.push('## Worth noting');
    for (const f of payload.flags) {
      lines.push(`- ${f}. This is scored conservatively until it is measured, so tracking it can only help your score.`);
    }
    lines.push('');
  }

  // Progress since the prior assessment, when comparable.
  const cmp = payload.prior_comparison;
  if (cmp && cmp.comparable) {
    const delta = cmp.drs_delta ?? 0;
    const resolved = cmp.gaps_resolved ?? [];
    lines.push('## Progress since your last assessment');
    const direction = delta >= 0 ? 'up' : 'down';
    lines.push(
      `Your score moved from ${cmp.prior_drs} to ${payload.overall_score}, ${direction} ${Math.abs(delta)} points.`,
    );
    if (resolved.length > 0) {
      lines.push(`Gaps cleared since last time: ${resolved.length}. That work is what moved the score.`);
    }
    lines.push('');
  } else if (cmp && !cmp.comparable) {
    lines.push('## Progress since your last assessment');
    lines.push('The methodology was updated between assessments, so the two scores are not directly comparable.');
    lines.push('');
  }

  // What happens next.
  lines.push('## What happens next');
  const window = payload.engagement_target_window
    ? ` within your ${payload.engagement_target_window} target window`
    : '';
  lines.push(
    `Your advisor will work the priorities above with you${window}, then re-assess to confirm each fix moved the score. Questions about legal or tax structure should go to your advisor and counsel.`,
  );
  void gapReason; // shared with the results page; retained for future gap-level detail

  return lines.join('\n');
}

// --- generateDocument -----------------------------------------------------------

async function generateWithClaude(
  payload: unknown,
  generate: GenerateFn,
  promptVersion: string = PROMPT_VERSION,
): Promise<GeneratedText> {
  const systemPrompt = readFileSync(join(root, 'prompts', `${promptVersion}.md`), 'utf8');
  const userContent = `Assessment data (JSON):\n${JSON.stringify(payload, null, 2)}`;

  // One regeneration on a numeral violation, then fail loudly (docs/04).
  let generated = await generate(systemPrompt, userContent);
  let violations = numeralPostCheck(generated.text, payload);
  if (violations.length > 0) {
    generated = await generate(
      systemPrompt,
      `${userContent}\n\nIMPORTANT: your previous draft used numbers not present in the data (${violations.join(', ')}). Use only numbers from the payload.`,
    );
    violations = numeralPostCheck(generated.text, payload);
    if (violations.length > 0) {
      throw new Error(
        `narrative rejected: output contains numerals not present in the input payload: ${violations.join(', ')}`,
      );
    }
  }
  return generated;
}

export async function generateDocument(
  db: pg.ClientBase,
  assessmentId: string,
  docType: string,
  // Explicit generator forces the AI path (used by tests). Omit it and the
  // service picks: Claude when ANTHROPIC_API_KEY is set, otherwise the
  // deterministic composer — so a report always generates.
  generate?: GenerateFn,
) {
  if (docType === 'delta_report') return generateDeltaReport(db, assessmentId, generate);
  if (docType === 'cim') return generateCim(db, assessmentId, generate);
  if (docType !== 'owner_report') {
    throw new Error(`doc_type '${docType}' is not implemented yet (owner_report, delta_report, cim)`);
  }

  const payload = await buildOwnerReportPayload(db, assessmentId);

  let text: string;
  let model: string;
  if (generate) {
    ({ text, model } = await generateWithClaude(payload, generate));
  } else if (process.env.ANTHROPIC_API_KEY) {
    ({ text, model } = await generateWithClaude(payload, callClaude));
  } else {
    const explain = await explainAssessment(db, assessmentId);
    text = composeOwnerReport(payload, explain);
    model = RULE_BASED_MODEL;
  }

  const assessment = (
    await db.query(`select firm_id, engagement_id from assessments where id = $1`, [assessmentId])
  ).rows[0];
  const row = await db.query(
    `insert into generated_documents (firm_id, engagement_id, assessment_id, doc_type, content_md, prompt_version, model)
     values ($1, $2, $3, 'owner_report', $4, $5, $6)
     returning *`,
    [assessment.firm_id, assessment.engagement_id, assessmentId, text, PROMPT_VERSION, model],
  );
  return row.rows[0];
}

// --- Delta report (F4) --------------------------------------------------------
// The quarterly artifact a wealth advisor brings to the client meeting. Built
// FROM the deterministic comparison (compareAssessments) of the current active
// completed assessment against the prior one. When there is no prior (or the
// prior is on a different rubric version), it renders as a Baseline report:
// levels, not deltas. Every figure comes from the payload; the numeral firewall
// applies exactly as for the owner report.

const DELTA_PROMPT_VERSION = 'delta_report.v1';

export interface DeltaReportPayload {
  mode: 'delta' | 'baseline';
  company: { name: string; industry: string | null };
  engagement_target_window: string | null;
  current: { drs: number; tier: string; ori: number; date: string | null };
  prior: { drs: number; tier: string; ori: number; date: string | null } | null;
  drs_delta: number | null;
  ori_delta: number | null;
  dimensions: { name: string; current: number; prior: number | null; delta: number | null }[];
  gaps_resolved: string[];
  gaps_opened: string[];
  open_gaps: string[]; // baseline mode: current fired gaps by name
  // Counts are in the payload so both the composer and the model may state them
  // without tripping the numeral firewall (no self-computed numbers).
  counts: { gaps_resolved: number; gaps_opened: number; open_gaps: number };
}

async function priorActiveCompleted(
  db: pg.ClientBase,
  engagementId: string,
  sequenceNumber: number,
): Promise<{ id: string; rubric_version_id: string } | null> {
  const r = await db.query(
    `select id, rubric_version_id from active_assessments
     where engagement_id = $1 and status = 'completed' and sequence_number < $2
     order by sequence_number desc limit 1`,
    [engagementId, sequenceNumber],
  );
  return r.rows[0] ?? null;
}

export async function buildDeltaReportPayload(
  db: pg.ClientBase,
  currentAssessmentId: string,
): Promise<DeltaReportPayload> {
  const assessment = (
    await db.query(
      `select a.*, e.company_id, e.target_exit_window
       from active_assessments a join engagements e on e.id = a.engagement_id
       where a.id = $1 and a.status = 'completed'`,
      [currentAssessmentId],
    )
  ).rows[0];
  if (!assessment) throw new Error(`assessment ${currentAssessmentId} not found, not completed, or superseded`);

  const company = (
    await db.query(`select name, industry from companies where id = $1`, [assessment.company_id])
  ).rows[0];
  const dimNames = new Map<string, string>(
    (
      await db.query(`select code, name from dimensions where rubric_version_id = $1`, [
        assessment.rubric_version_id,
      ])
    ).rows.map((r) => [r.code, r.name]),
  );
  const gapNames = new Map<string, string>(
    (
      await db.query(`select code, name from gap_definitions where rubric_version_id = $1`, [
        assessment.rubric_version_id,
      ])
    ).rows.map((r) => [r.code, r.name]),
  );

  const explain = await explainAssessment(db, currentAssessmentId);
  const prior = await priorActiveCompleted(db, assessment.engagement_id, assessment.sequence_number);
  const comparison = prior ? await compareAssessments(db, prior.id, currentAssessmentId) : null;

  const baseHeadline = {
    drs: explain.drsScore,
    tier: explain.drsTier,
    ori: explain.oriScore,
    date: assessment.completed_at,
  };

  if (comparison && comparison.comparable) {
    const priorDate = (
      await db.query(`select completed_at from assessments where id = $1`, [prior!.id])
    ).rows[0]?.completed_at ?? null;
    return {
      mode: 'delta',
      company: { name: company.name, industry: company.industry },
      engagement_target_window: assessment.target_exit_window,
      current: baseHeadline,
      prior: {
        drs: comparison.prior.drsScore,
        tier: comparison.prior.drsTier,
        ori: comparison.prior.oriScore,
        date: priorDate,
      },
      drs_delta: comparison.drsDelta,
      ori_delta: comparison.oriDelta,
      dimensions: comparison.dimensions.map((d) => ({
        name: dimNames.get(d.code) ?? d.code,
        current: d.current,
        prior: d.prior,
        delta: d.delta,
      })),
      gaps_resolved: comparison.gapsResolved.map((c) => gapNames.get(c) ?? c),
      gaps_opened: comparison.gapsOpened.map((c) => gapNames.get(c) ?? c),
      open_gaps: explain.firedGaps.map((g) => g.name),
      counts: {
        gaps_resolved: comparison.gapsResolved.length,
        gaps_opened: comparison.gapsOpened.length,
        open_gaps: explain.firedGaps.length,
      },
    };
  }

  // Baseline (no prior, or prior on a different rubric version → not comparable)
  return {
    mode: 'baseline',
    company: { name: company.name, industry: company.industry },
    engagement_target_window: assessment.target_exit_window,
    current: baseHeadline,
    prior: null,
    drs_delta: null,
    ori_delta: null,
    dimensions: explain.dimensions.map((d) => ({
      name: d.name,
      current: d.score,
      prior: null,
      delta: null,
    })),
    gaps_resolved: [],
    gaps_opened: [],
    open_gaps: explain.firedGaps.map((g) => g.name),
    counts: { gaps_resolved: 0, gaps_opened: 0, open_gaps: explain.firedGaps.length },
  };
}

// Deterministic composer — numeral-firewall-safe (uses only payload figures).
export function composeDeltaReport(payload: DeltaReportPayload): string {
  const { company, current, prior } = payload;
  const lines: string[] = [];
  const period = payload.mode === 'delta' ? 'Progress this period' : 'Baseline readiness';
  lines.push(`# ${period} — ${company.name}`);
  lines.push('');

  if (payload.mode === 'delta' && prior) {
    const dir = (payload.drs_delta ?? 0) >= 0 ? 'up' : 'down';
    lines.push(
      `Since the last review, ${company.name}'s Diligence Readiness Score moved from ${prior.drs} to ${current.drs} — ${dir} ${Math.abs(payload.drs_delta ?? 0)} points, now in the ${current.tier} tier.`,
    );
    if (payload.counts.gaps_resolved > 0) {
      lines.push('');
      lines.push(
        `${payload.counts.gaps_resolved} diligence gap${payload.counts.gaps_resolved > 1 ? 's were' : ' was'} cleared this period. That work is what moved the score.`,
      );
    }
  } else {
    lines.push(
      `This baseline places ${company.name} at a Diligence Readiness Score of ${current.drs}, in the ${current.tier} tier. It is the starting point the plan builds from.`,
    );
  }
  lines.push('');
  lines.push('## The six business areas');
  for (const d of payload.dimensions) {
    if (payload.mode === 'delta' && d.prior != null) {
      lines.push(`- **${d.name}** — ${d.prior} to ${d.current}.`);
    } else {
      lines.push(`- **${d.name}** — ${d.current}.`);
    }
  }
  lines.push('');

  if (payload.mode === 'delta' && payload.gaps_resolved.length > 0) {
    lines.push('## Gaps closed this period');
    for (const g of payload.gaps_resolved) lines.push(`- ${g}`);
    lines.push('');
  }
  if (payload.open_gaps.length > 0) {
    lines.push('## Focus for next period');
    for (const g of payload.open_gaps.slice(0, 6)) lines.push(`- ${g}`);
    lines.push('');
  }

  lines.push('## What happens next');
  const window = payload.engagement_target_window
    ? ` within the ${payload.engagement_target_window} target window`
    : '';
  lines.push(
    `Your advisor will work the focus items above with you${window}, then re-assess to confirm each fix moved the score.`,
  );
  return lines.join('\n');
}

async function generateDeltaReport(
  db: pg.ClientBase,
  currentAssessmentId: string,
  generate?: GenerateFn,
) {
  const payload = await buildDeltaReportPayload(db, currentAssessmentId);

  let text: string;
  let model: string;
  if (generate) {
    ({ text, model } = await generateWithClaude(payload, generate, DELTA_PROMPT_VERSION));
  } else if (process.env.ANTHROPIC_API_KEY) {
    ({ text, model } = await generateWithClaude(payload, callClaude, DELTA_PROMPT_VERSION));
  } else {
    text = composeDeltaReport(payload);
    model = 'rule-based:delta_report.v1';
  }

  const assessment = (
    await db.query(`select firm_id, engagement_id from assessments where id = $1`, [currentAssessmentId])
  ).rows[0];
  const row = await db.query(
    `insert into generated_documents (firm_id, engagement_id, assessment_id, doc_type, content_md, prompt_version, model)
     values ($1, $2, $3, 'delta_report', $4, $5, $6)
     returning *`,
    [assessment.firm_id, assessment.engagement_id, currentAssessmentId, text, DELTA_PROMPT_VERSION, model],
  );
  return row.rows[0];
}

// --- CIM (Confidential Information Memorandum) ---------------------------------
// The market-facing deliverable: prose composed FROM the strengths/valuation/
// evidence payload (server/cim.ts). Buyer-facing marketing, so the payload
// carries strengths and verified facts only — the numeral firewall applies
// exactly as for the other documents.

const CIM_PROMPT_VERSION = 'cim.v1';

async function generateCim(db: pg.ClientBase, assessmentId: string, generate?: GenerateFn) {
  const payload = await buildCimPayload(db, assessmentId);

  let text: string;
  let model: string;
  if (generate) {
    ({ text, model } = await generateWithClaude(payload, generate, CIM_PROMPT_VERSION));
  } else if (process.env.ANTHROPIC_API_KEY) {
    ({ text, model } = await generateWithClaude(payload, callClaude, CIM_PROMPT_VERSION));
  } else {
    text = composeCim(payload);
    model = 'rule-based:cim.v1';
  }

  const assessment = (
    await db.query(`select firm_id, engagement_id from assessments where id = $1`, [assessmentId])
  ).rows[0];
  const row = await db.query(
    `insert into generated_documents (firm_id, engagement_id, assessment_id, doc_type, content_md, prompt_version, model)
     values ($1, $2, $3, 'cim', $4, $5, $6)
     returning *`,
    [assessment.firm_id, assessment.engagement_id, assessmentId, text, CIM_PROMPT_VERSION, model],
  );
  return row.rows[0];
}
