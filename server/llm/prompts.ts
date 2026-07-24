// Versioned prompt registry. Every LLM call names a prompt_key here; no prompt
// text lives inline at a call site. A prompt is (key, version, model hint, a
// system string, and a render function for the user turn). The key is what gets
// logged to llm_calls.prompt_key, so cost and eval scores are attributable to a
// specific prompt version.

import { modelForTier } from './models';

export interface PromptDef<Vars = Record<string, unknown>> {
  key: string;
  version: string;
  model: string;
  system: string;
  render: (vars: Vars) => string;
}

// Model per prompt comes from the tier router (server/llm/models.ts), not a
// hardcoded frontier model: extraction and short finding drafts are simple,
// structured tasks, so they route to the cheap tiers instead of paying opus rates.
// Tunable via the AI_MODEL_* env overrides without a deploy.
const EXTRACTION_MODEL = modelForTier('economy'); // structured values-only extraction — the free tier handles it
const FINDING_MODEL = modelForTier('standard'); // a 2-3 sentence evidence-bound draft — cheap, capable

// Extraction: turn a document's parsed text into structured facts. The extract
// step validates the model's output with extractionOutputSchema and rejects
// anything non-conforming. Kept deliberately strict: values only, no prose.
export const extractFinancialsV1: PromptDef<{ documentText: string; category: string }> = {
  key: 'extract.financials.v1',
  version: 'v1',
  model: EXTRACTION_MODEL,
  system:
    'You extract structured financial facts from a source document. Return ONLY facts ' +
    'present in the text. Never infer or compute a value that is not written. Each fact ' +
    'has a stable fact_key, a JSON fact_value, a confidence in [0,1], and the source page ' +
    'and span it came from. Do not return narrative.',
  render: ({ documentText, category }) =>
    `Document category: ${category}\n\n---\n${documentText}\n---\n\n` +
    'Extract the facts as JSON matching the required schema.',
};

// Finding narrative: draft prose FROM a finding's graph evidence. The findings
// engine rejects any output asserting a number not present in the evidence.
export const findingNarrativeV1: PromptDef<{
  patternDescription: string;
  evidenceJson: string;
}> = {
  key: 'finding.narrative.v1',
  version: 'v1',
  model: FINDING_MODEL,
  system:
    'You draft a short diligence finding FROM structured evidence. You may only cite ' +
    'numbers that appear in the evidence JSON. Do not introduce any figure that is not ' +
    'in the evidence. Output is a draft for human review; be factual and concise.',
  render: ({ patternDescription, evidenceJson }) =>
    `Finding pattern: ${patternDescription}\n\nEvidence:\n${evidenceJson}\n\n` +
    'Write a 2-3 sentence finding using only the evidence above.',
};

// Answer extraction (docs/sellside-ai WS-EXTRACT). Turn a data-room document's
// text into PROPOSED assessment answers a human confirms — the AI never writes to
// a scoring table (rule 2). Runs on the 'economy' tier: this is mechanical,
// values-only work, not narrative, so the cheapest/free model is the right one. It
// is given the exact list of questions to answer and must return ONLY a value for
// a question actually evidenced in the text, each with a confidence and the source
// span. answerCandidatesOutputSchema (shared/intelligence/schemas) rejects any
// non-conforming output before a candidate row is staged.
export const extractAnswerCandidatesV1: PromptDef<{ documentText: string; questionsJson: string }> = {
  key: 'extract.answer_candidates.v1',
  version: 'v1',
  model: modelForTier('economy'),
  system:
    'You propose candidate answers to assessment questions from a source document. ' +
    'You are given a list of questions (each with a code, a prompt, and an answer type) ' +
    'and the document text. Return ONLY a candidate for a question whose answer is ' +
    'explicitly evidenced in the text. Never infer, compute, or guess a value that is ' +
    'not written. Each candidate has the question_code, a JSON value, a confidence in ' +
    '[0,1], and the source span (a short quoted excerpt) it came from. Return values ' +
    'only — no prose, no explanation. Omit any question you cannot evidence.',
  render: ({ documentText, questionsJson }) =>
    `Questions to answer (JSON):\n${questionsJson}\n\n---\n${documentText}\n---\n\n` +
    'Return the candidates as JSON matching the required schema.',
};

export const PROMPT_REGISTRY = {
  [extractFinancialsV1.key]: extractFinancialsV1,
  [findingNarrativeV1.key]: findingNarrativeV1,
  [extractAnswerCandidatesV1.key]: extractAnswerCandidatesV1,
} as const;

export function getPrompt(key: string): PromptDef {
  const p = PROMPT_REGISTRY[key as keyof typeof PROMPT_REGISTRY];
  if (!p) throw new Error(`unknown prompt_key ${key}`);
  return p as PromptDef;
}
