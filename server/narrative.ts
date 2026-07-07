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

const PROMPT_VERSION = 'owner_report.v1';
const MODEL = 'claude-opus-4-8';

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

// --- generateDocument -----------------------------------------------------------

export async function generateDocument(
  db: pg.ClientBase,
  assessmentId: string,
  docType: string,
  generate: GenerateFn = callClaude,
) {
  if (docType !== 'owner_report') {
    throw new Error(`doc_type '${docType}' is not implemented yet (owner_report only until S11)`);
  }

  const payload = await buildOwnerReportPayload(db, assessmentId);
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

  const assessment = (
    await db.query(`select firm_id, engagement_id from assessments where id = $1`, [assessmentId])
  ).rows[0];
  const row = await db.query(
    `insert into generated_documents (firm_id, engagement_id, assessment_id, doc_type, content_md, prompt_version, model)
     values ($1, $2, $3, 'owner_report', $4, $5, $6)
     returning *`,
    [assessment.firm_id, assessment.engagement_id, assessmentId, generated.text, PROMPT_VERSION, generated.model],
  );
  return row.rows[0];
}
