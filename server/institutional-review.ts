// Institutional Review seam (docs/04 AI-layer boundary + docs/20 "AI as an
// intelligence layer" / institutional reviewer).
//
// Today the Reasoning Engine writes prose FROM structured data (server/narrative.ts).
// This module adds the *reviewer* half of docs/20: it assembles a read-only
// picture of an assessment — the deterministic scores + dimension breakdown, the
// flagged gaps, the evidence/verification gaps, and the fired buyer-lens/advisory
// items — and turns it into a LABELED DRAFT "Institutional Review": blind spots,
// missing evidence, and the likely diligence questions a sophisticated buyer will
// ask. It is the "simulate institutional diligence before the market does" idea,
// expressed as narrative for the advisor to review.
//
// CLAUDE.md rule 1 & 2 guarantee — this is the same boundary server/narrative.ts
// enforces, restated so it can never be lost:
//   * The AI NEVER computes, adjusts, influences, or grades a score. Every number
//     comes from the deterministic engine, is placed in the payload server-side,
//     and is the ONLY number the model may use (numeralPostCheck, reused verbatim
//     from narrative.ts, rejects any numeral the payload did not already contain).
//   * Output is always labeled DRAFT and carries a prompt_version. The reviewer
//     surfaces questions and patterns; it does not decide, price, or score.
//   * Injectable generator: Anthropic when ANTHROPIC_API_KEY is set, otherwise a
//     deterministic composer, so a review is always available and tests are
//     key-free (identical seam to narrative.ts).
//
// This module is read-only. It writes to NO table (scoring or otherwise) — it
// returns an in-memory labeled-draft artifact. Persisting it (a generated_documents
// `institutional_review` doc_type) is a follow-up that needs a migration; see the
// integration notes accompanying this change.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { numeralPostCheck, type GenerateFn, type GeneratedText } from './narrative';
import { aiConfigured, aiFailureReason, resolveProvider } from './llm/provider';
import { verificationSummary, type VerificationSummary } from './verification';
import { fireAdvisoryItems, type AdvisoryFireResult } from './advisory';

const PROMPT_VERSION = 'institutional_review.v1';
const MODEL = 'claude-opus-4-8';
// Model label stored on a review written by the deterministic composer, so a
// reader can always tell a rule-based review from an AI-drafted one.
const RULE_BASED_MODEL = 'rule-based:institutional_review.v1';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The unmissable label on every review, AI- or rule-composed. It carries no
// numeral, so prepending it never trips the numeral firewall.
export const DRAFT_BANNER =
  '_DRAFT — Institutional Review. AI-assisted observations assembled for advisor ' +
  'review only. This review surfaces blind spots, missing evidence, and likely ' +
  'diligence questions from the assessment data. It does not compute, adjust, or ' +
  'grade any score; every figure it cites was produced by the deterministic engine._';

function withDraftBanner(text: string): string {
  return text.startsWith(DRAFT_BANNER) ? text : `${DRAFT_BANNER}\n\n${text}`;
}

async function callClaude(systemPrompt: string, userContent: string): Promise<GeneratedText> {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      'institutional review service not configured: set AI_GATEWAY_API_KEY (or ANTHROPIC_API_KEY) in the server environment',
    );
  }
  const response = await provider.client.messages.create({
    model: provider.modelFor(MODEL),
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) throw new Error(`institutional review returned no text (${response.stop_reason})`);
  return { text, model: response.model };
}

// --- Payload (the only numbers the model may use) ------------------------------

export interface ReviewDimension {
  name: string;
  score: number;
}
export interface ReviewGap {
  name: string;
  severity: string;
}
export interface ReviewDiligenceItem {
  title: string;
  severity: string | null;
  buyer_type: string | null;
  // The buyer-facing question / concern text from the advisory catalog.
  concern: string;
}
export interface ReviewEvidenceGaps {
  // Descriptive verification posture — never a score. Counts are precomputed
  // server-side so the model may state them without computing anything.
  verified_inputs: number;
  total_inputs: number;
  pct: number;
  tier: string;
  // The financial inputs still resting on self-report (the missing evidence).
  unverified: string[];
}

// Everything the reviewer may reason over — assembled entirely from deterministic
// output. No raw answers, no recomputation; the model reads this and nothing else.
export interface ReviewPayload {
  company: { name: string; industry: string | null };
  engagement_target_window: string | null;
  overall_score: number;
  band: string;
  owner_readiness_index: number;
  dimensions: ReviewDimension[];
  flagged_gaps: ReviewGap[];
  // Score-conservative "not tracked / not measured" markers from the engine.
  flags: string[];
  evidence_gaps: ReviewEvidenceGaps;
  // The diligence questions the deterministic buyer-lens catalog already fired.
  likely_diligence_questions: ReviewDiligenceItem[];
}

// The structured inputs the payload is assembled FROM. Kept as an explicit seam
// (like buildOwnerReportPayload's use of explainAssessment) so the pure assembler
// below is testable without a database.
export interface ReviewSources {
  company: { name: string; industry: string | null };
  engagement_target_window: string | null;
  overall_score: number;
  band: string;
  owner_readiness_index: number;
  dimensions: ReviewDimension[];
  flagged_gaps: ReviewGap[];
  flags: string[];
  verification: VerificationSummary;
  advisory: AdvisoryFireResult;
}

// Pure: fold the gathered structured inputs into the reviewer payload. Selects
// the buyer-lens items that read as diligence questions/risks (never education),
// and reduces the verification summary to its evidence-gap view. Computes no
// score and derives no new number — it only reshapes deterministic output.
export function assembleReviewPayload(sources: ReviewSources): ReviewPayload {
  const unverified = sources.verification.inputs
    .filter((i) => i.source === 'self_reported')
    .map((i) => i.prompt);

  const likely = sources.advisory.items
    .filter((it) => it.item_type === 'buyer_question' || it.item_type === 'risk_flag')
    .map((it) => ({
      title: it.title,
      severity: it.severity,
      buyer_type: it.buyer_type,
      concern: it.body,
    }));

  return {
    company: sources.company,
    engagement_target_window: sources.engagement_target_window,
    overall_score: sources.overall_score,
    band: sources.band,
    owner_readiness_index: sources.owner_readiness_index,
    dimensions: sources.dimensions,
    flagged_gaps: sources.flagged_gaps,
    flags: sources.flags,
    evidence_gaps: {
      verified_inputs: sources.verification.verified_inputs,
      total_inputs: sources.verification.total_inputs,
      pct: sources.verification.pct,
      tier: sources.verification.tier,
      unverified,
    },
    likely_diligence_questions: likely,
  };
}

// Gather the structured inputs from persisted deterministic results and fold them
// into the payload. Reads only — dimension_scores, gaps, and the descriptive
// verification/advisory rollups (both of which read scores and never write one).
// Mirrors buildOwnerReportPayload: the server produces every figure; the model
// gets a finished payload.
export async function buildInstitutionalReviewPayload(
  db: pg.ClientBase,
  assessmentId: string,
): Promise<ReviewPayload> {
  const header = (
    await db.query(
      `select a.id, a.engagement_id, a.drs_score, a.drs_tier, a.ori_score,
              e.target_exit_window, c.name as company_name, c.industry
       from active_assessments a
       join engagements e on e.id = a.engagement_id
       join companies c on c.id = e.company_id
       where a.id = $1 and a.status = 'completed'`,
      [assessmentId],
    )
  ).rows[0];
  if (!header) throw new Error(`assessment ${assessmentId} not found, not completed, or superseded`);

  const dimensions: ReviewDimension[] = (
    await db.query(
      `select d.name, ds.score
       from dimension_scores ds
       join dimensions d on d.id = ds.dimension_id
       where ds.assessment_id = $1
       order by d.sort_order`,
      [assessmentId],
    )
  ).rows.map((r) => ({ name: r.name, score: Number(r.score) }));

  // Critical-first, like the roadmap / advisory library.
  const severityRank: Record<string, number> = { critical: 0, high: 1, med: 2, low: 3 };
  const flagged_gaps: ReviewGap[] = (
    await db.query(
      `select gd.name, gd.severity
       from gaps g
       join gap_definitions gd on gd.id = g.gap_definition_id
       where g.engagement_id = $1 and g.status in ('open', 'in_remediation')`,
      [header.engagement_id],
    )
  ).rows
    .map((r) => ({ name: r.name, severity: r.severity }))
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));

  const verification = await verificationSummary(db, assessmentId);
  const advisory = await fireAdvisoryItems(db, header.engagement_id);

  return assembleReviewPayload({
    company: { name: header.company_name, industry: header.industry ?? null },
    engagement_target_window: header.target_exit_window ?? null,
    overall_score: Number(header.drs_score),
    band: header.drs_tier,
    owner_readiness_index: Number(header.ori_score),
    dimensions,
    flagged_gaps,
    // The engine's "not tracked" flags aren't persisted per-assessment; they are
    // an explain-trace artifact. The reviewer treats them as blind spots when
    // present, and simply omits the section when the caller has none.
    flags: [],
    verification,
    advisory,
  });
}

// --- Deterministic composer (no API key required) -------------------------------
// Rule-based review assembled from the payload alone — invents nothing, computes
// nothing (CLAUDE.md rule 1/2-safe). It phrases the deterministic picture as the
// three reviewer lenses of docs/20. Every numeral it emits is a payload numeral,
// so numeralPostCheck(composeInstitutionalReview(p), p) is empty by construction.
// Always available (demos, key-less environments) and fully defensible.
export function composeInstitutionalReview(payload: ReviewPayload): string {
  const { company } = payload;
  const lines: string[] = [];

  lines.push(`# Institutional Review — ${company.name}`);
  lines.push('');
  lines.push(DRAFT_BANNER);
  lines.push('');
  lines.push(
    `This review reads the assessment as a sophisticated buyer's diligence team would, ` +
      `to surface what they will probe before they do. It is a prompt for the advisor's ` +
      `judgment, not a grade: the Diligence Readiness Score of ${payload.overall_score} ` +
      `(${payload.band}) and every figure below come from the deterministic engine.`,
  );
  lines.push('');

  // Blind spots — the flagged gaps and any not-tracked flags, framed as what a
  // buyer will notice that the owner may not be watching.
  lines.push('## Blind spots a buyer will probe');
  if (payload.flagged_gaps.length === 0 && payload.flags.length === 0) {
    lines.push(
      'No gaps were flagged and nothing is marked untracked. The review shifts to holding the position and preparing materials for scrutiny.',
    );
  } else {
    for (const g of payload.flagged_gaps) {
      lines.push(
        `- **${g.name}** (${g.severity}). Expect diligence to open here; getting ahead of it keeps the process on the owner's terms rather than the buyer's.`,
      );
    }
    for (const f of payload.flags) {
      lines.push(
        `- ${f}. This is not currently measured, so a buyer cannot verify it and will assume the conservative case until it is.`,
      );
    }
  }
  lines.push('');

  // Missing evidence — the verification posture as the proof still to assemble.
  lines.push('## Missing evidence');
  const ev = payload.evidence_gaps;
  if (ev.total_inputs === 0) {
    lines.push('No financial inputs are in scope for verification on this assessment.');
  } else if (ev.unverified.length === 0) {
    lines.push(
      `The financial inputs in scope are backed by documents or a connected ledger (${ev.verified_inputs} of ${ev.total_inputs}). The evidence a buyer would request is in hand.`,
    );
  } else {
    lines.push(
      `${ev.verified_inputs} of ${ev.total_inputs} financial inputs are substantiated (${ev.tier}). The following still rest on self-report and are the proof a buyer will ask to see:`,
    );
    for (const u of ev.unverified) lines.push(`- ${u}`);
  }
  lines.push('');

  // Likely diligence questions — the deterministic buyer-lens catalog, verbatim.
  lines.push('## Likely diligence questions');
  if (payload.likely_diligence_questions.length === 0) {
    lines.push('The buyer-lens catalog fired no questions at the current scores. Revisit after the next assessment.');
  } else {
    for (const q of payload.likely_diligence_questions) {
      const who = q.buyer_type ? ` (${q.buyer_type})` : '';
      lines.push(`### ${q.title}${who}`);
      lines.push(q.concern);
      lines.push('');
    }
  }

  lines.push('## For the advisor');
  const window = payload.engagement_target_window
    ? ` within the ${payload.engagement_target_window} target window`
    : '';
  lines.push(
    `Treat the items above as a diligence rehearsal${window}. Each is a question to answer before the market asks it. Legal and tax structure questions belong with the advisor and counsel; this review does not opine on them.`,
  );

  return withDraftBanner(lines.join('\n'));
}

// --- Review generation (injectable generator + numeral firewall) ----------------

// Mirrors narrative.ts's generateWithClaude: read the versioned prompt, generate,
// enforce the numeral firewall (one regeneration, then fail loudly), and stamp
// the DRAFT banner so the label is present regardless of what the model returned.
async function reviewWithGenerator(
  payload: ReviewPayload,
  generate: GenerateFn,
  promptVersion: string = PROMPT_VERSION,
): Promise<GeneratedText> {
  const systemPrompt = readFileSync(join(root, 'prompts', `${promptVersion}.md`), 'utf8');
  const userContent = `Assessment review data (JSON):\n${JSON.stringify(payload, null, 2)}`;

  let generated = await generate(systemPrompt, userContent);
  let violations = numeralPostCheck(generated.text, payload);
  if (violations.length > 0) {
    generated = await generate(
      systemPrompt,
      `${userContent}\n\nIMPORTANT: your previous draft used numbers not present in the data (${violations.join(', ')}). Use only numbers from the payload, and never compute a number of your own.`,
    );
    violations = numeralPostCheck(generated.text, payload);
    if (violations.length > 0) {
      throw new Error(
        `institutional review rejected: output contains numerals not present in the input payload: ${violations.join(', ')}`,
      );
    }
  }
  return { text: withDraftBanner(generated.text), model: generated.model };
}

export interface InstitutionalReview {
  doc_type: 'institutional_review';
  prompt_version: string;
  model: string;
  is_draft: true; // always — this seam only ever produces draft narrative
  content_md: string;
  payload: ReviewPayload;
}

// Build the payload, then produce the labeled draft review. Generator selection
// matches narrative.ts exactly: an explicit generator forces the AI path and
// stays strict (tests); otherwise Claude when AI is configured (AI_GATEWAY_API_KEY
// or ANTHROPIC_API_KEY), falling back to the deterministic composer on any AI
// failure — so a review always generates, seamlessly, even with no gateway
// balance. Read-only: returns the artifact, writes nothing.
export async function generateInstitutionalReview(
  db: pg.ClientBase,
  assessmentId: string,
  generate?: GenerateFn,
): Promise<InstitutionalReview> {
  const payload = await buildInstitutionalReviewPayload(db, assessmentId);

  let text: string;
  let model: string;
  if (generate) {
    ({ text, model } = await reviewWithGenerator(payload, generate));
  } else if (aiConfigured()) {
    try {
      ({ text, model } = await reviewWithGenerator(payload, callClaude));
    } catch (err) {
      console.warn(
        `institutional review ${PROMPT_VERSION}: AI generation failed (${aiFailureReason(err)}); ` +
          'falling back to the deterministic composer',
      );
      text = composeInstitutionalReview(payload);
      model = RULE_BASED_MODEL;
    }
  } else {
    text = composeInstitutionalReview(payload);
    model = RULE_BASED_MODEL;
  }

  return {
    doc_type: 'institutional_review',
    prompt_version: PROMPT_VERSION,
    model,
    is_draft: true,
    content_md: text,
    payload,
  };
}
