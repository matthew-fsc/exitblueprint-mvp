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
  payload: OwnerReportPayload,
  generate: GenerateFn,
): Promise<GeneratedText> {
  const systemPrompt = readFileSync(join(root, 'prompts', `${PROMPT_VERSION}.md`), 'utf8');
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
  if (docType !== 'owner_report') {
    throw new Error(`doc_type '${docType}' is not implemented yet (owner_report only until S11)`);
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
