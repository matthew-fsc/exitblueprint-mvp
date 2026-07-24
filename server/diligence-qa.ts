// Diligence Q&A assistant (docs/sellside-ai/05 §4). A buyer asks a diligence
// question ("What's your customer concentration?", "Walk me through revenue by
// year"); this answers it FROM the engagement's OWN structured, cited knowledge —
// verified financial inputs, ready data-room items, fired gaps, advisory findings
// (server/intelligence/retrieval.ts) — drafted by the shared intelligence runtime,
// and persisted immutably.
//
// It is the same reasoning pipeline as the deliverables, pointed at a free-form
// question. The AI narrates FROM the retrieved facts (rule 2): the numeral firewall
// rejects any numeral not in the payload and the citation contract requires each
// retrieved figure to carry its [cite_id]. The AI never computes a score (rule 1).
// Every answer is a labeled draft for advisor review; each is an immutable snapshot
// stamped with prompt_version + model (rules 4/6) — re-asking makes a NEW row.
//
// THE RETRIEVAL-ONLY FALLBACK (the point of building on the shared runtime). When
// the AI call fails — no credit in the account, or any provider error — the
// deliverables path falls back to its deterministic COMPOSER. A free-form answer
// can't be composed rule-based, so the honest degradation here is retrieval-only:
// composeRetrievalOnly renders the ranked, cited source evidence for the advisor to
// synthesize from, stamped RULE_BASED_MODEL. The runtime needs no special case —
// `compose` is already a pluggable `() => string`, so this path comes for free.
import type pg from 'pg';
import { runGroundedGeneration, type GenerateFn } from './intelligence/runtime';
import { engagementKnowledgeSource, type GroundedPassage } from './intelligence/retrieval';
import { getAgentOrThrow } from './agents/registry';

// prompt_version + the rule-based (retrieval-only) model label come from the agent
// registry — the single source of truth — not local literals. RULE_BASED_MODEL is
// how the runtime stamps a composed (non-AI) draft, and how `mode` is derived below.
const QA_AGENT = getAgentOrThrow('diligence_qa');
export const PROMPT_VERSION = QA_AGENT.promptVersion; // 'diligence_qa.v1'
export const RULE_BASED_MODEL = QA_AGENT.ruleBasedModel; // 'retrieval-only:diligence_qa.v1'

// The shapes another agent renders verbatim. EvidenceRef is exactly the retrieval
// GroundedPassage shape (with the source narrowed to the known kinds); DiligenceQa
// is one persisted, immutable answer.
export type EvidenceRef = {
  cite_id: string;
  citation: string;
  body: string;
  source: 'verified_fact' | 'data_room' | 'gap' | 'advisory' | 'market';
};

export type DiligenceQa = {
  id: string;
  question: string;
  answer_md: string;
  mode: 'ai' | 'retrieval_only';
  model: string;
  prompt_version: string;
  evidence: EvidenceRef[];
  created_at: string;
};

// timestamptz comes back from node-postgres as a Date on the DB path and as a
// string on a fake-db path; normalize to an ISO string so DiligenceQa.created_at
// is always the agreed string shape.
function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

// The DETERMINISTIC fallback: render the ranked, cited source evidence for the
// advisor to answer from when AI synthesis is unavailable. Uses ONLY retrieved
// text (passage bodies/citations) plus the question, so it is numeral-firewall-safe
// by construction. This is what `runGroundedGeneration` runs on the no-credit /
// AI-unconfigured path, stamping RULE_BASED_MODEL (→ mode 'retrieval_only').
export function composeRetrievalOnly(question: string, passages: GroundedPassage[]): string {
  const lines: string[] = [];
  lines.push('_AI synthesis is unavailable — here is the cited source evidence to answer from._');
  lines.push('');
  lines.push(`**Diligence question:** ${question}`);
  lines.push('');
  if (passages.length === 0) {
    lines.push('No cited source evidence was found for this question in the engagement knowledge base.');
    return lines.join('\n');
  }
  lines.push('## Source evidence');
  for (const p of passages) {
    lines.push(`- ${p.body} — Source: ${p.citation} [${p.cite_id}]`);
  }
  return lines.join('\n');
}

// Answer one diligence question and persist it as an immutable snapshot. Resolves
// the engagement's latest completed assessment, retrieves its cited knowledge,
// and drafts the answer through the shared runtime.
//
// GENERATOR SELECTION (owned by runGroundedGeneration, identical to deliverables):
//   * explicit `generate` (tests)                → strict AI path → mode 'ai'
//   * no generate + AI configured, call succeeds  → AI path       → mode 'ai'
//   * no generate + AI unconfigured, OR the AI call FAILS (no credit) → compose()
//     runs composeRetrievalOnly, stamped RULE_BASED_MODEL           → mode 'retrieval_only'
// The last bullet is the retrieval-only degradation — it comes for free from the
// same pick/firewall/fallback contract the deliverables path already uses.
//
// firmId is the caller's staff firm (manage-engagement scope), resolved upstream
// and trusted; it is stamped on the row, never taken from a request body.
export async function answerDiligenceQuestion(
  db: pg.ClientBase,
  firmId: string,
  engagementId: string,
  question: string,
  generate?: GenerateFn,
): Promise<DiligenceQa> {
  const assessment = (
    await db.query(
      `select id from assessments where engagement_id = $1 and status = 'completed'
       order by completed_at desc nulls last, created_at desc limit 1`,
      [engagementId],
    )
  ).rows[0];
  if (!assessment) {
    throw new Error(`engagement ${engagementId} has no completed assessment to answer from`);
  }
  const assessmentId: string = assessment.id;

  const { passages } = await engagementKnowledgeSource(db, { engagementId, assessmentId, question });

  const payload = { question, facts: passages };
  const userContent = `Diligence question and cited facts (JSON):\n${JSON.stringify(payload, null, 2)}`;

  const result = await runGroundedGeneration({
    db,
    promptVersion: PROMPT_VERSION,
    ruleBasedModel: RULE_BASED_MODEL,
    modelTier: QA_AGENT.modelTier,
    userContent,
    compose: () => composeRetrievalOnly(question, passages),
    // Supplying `citation` turns on the citation contract on the AI path: every
    // retrieved figure the draft states must carry its [cite_id] on the same line.
    citation: { passages },
    generate,
    label: 'diligence q&a',
    regenInstruction: 'Use only facts and numbers from the payload, and cite each with its bracketed [cite_id].',
  });

  // The composer path stamps RULE_BASED_MODEL; anything else is a real AI model id.
  const mode: 'ai' | 'retrieval_only' = result.model === RULE_BASED_MODEL ? 'retrieval_only' : 'ai';
  // The retrieved passages ARE the evidence (GroundedPassage is the EvidenceRef
  // shape); the source narrows from the retrieval's free string to the known kinds.
  const evidence: EvidenceRef[] = passages.map((p) => ({
    cite_id: p.cite_id,
    citation: p.citation,
    body: p.body,
    source: p.source as EvidenceRef['source'],
  }));

  const row = (
    await db.query(
      `insert into diligence_qa
         (firm_id, engagement_id, assessment_id, question, answer_md, mode, model, prompt_version, evidence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id, created_at`,
      [
        firmId,
        engagementId,
        assessmentId,
        question,
        result.text,
        mode,
        result.model,
        PROMPT_VERSION,
        JSON.stringify(evidence),
      ],
    )
  ).rows[0];

  return {
    id: row.id,
    question,
    answer_md: result.text,
    mode,
    model: result.model,
    prompt_version: PROMPT_VERSION,
    evidence,
    created_at: asIso(row.created_at),
  };
}

// Read an engagement's persisted Q&A history, newest first. Read-only; the caller
// is already authorized on the engagement (engagement scope). evidence comes back
// from the jsonb column already parsed.
export async function listDiligenceQa(
  db: pg.ClientBase,
  engagementId: string,
): Promise<DiligenceQa[]> {
  const rows = (
    await db.query(
      `select id, question, answer_md, mode, model, prompt_version, evidence, created_at
       from diligence_qa where engagement_id = $1 order by created_at desc`,
      [engagementId],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    answer_md: r.answer_md,
    mode: r.mode as 'ai' | 'retrieval_only',
    model: r.model,
    prompt_version: r.prompt_version,
    evidence: (r.evidence ?? []) as EvidenceRef[],
    created_at: asIso(r.created_at),
  }));
}
