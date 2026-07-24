// Source-agnostic grounded retrieval (docs/sellside-ai/05 §3). The read side of
// the intelligence runtime, generalized from server/market-retrieval.ts: any
// service grounds on the SAME shape — a list of citable passages — and the
// citation contract (server/intelligence/guards.ts) can police any of them.
//
// DETERMINISTIC, NO LLM IN THE LOOP (CLAUDE.md rules 1 & 2). Every source here is
// a plain read of already-computed, structured facts turned into cited passages;
// the model is never in the retrieval loop and never computes or influences what
// is returned. `engagementKnowledgeSource` retrieves over an engagement's OWN
// knowledge (verified financial inputs, ready data-room items, fired gaps,
// advisory findings); `marketSource` wraps the existing market RAG so the two
// unify behind one interface. Ranking is a simple keyword overlap — no index, no
// embeddings, no scoring — so the same question always yields the same passages.
//
// FIRM SCOPE COMES FROM THE CALLER. This module takes an engagement/assessment id
// the caller already resolved and authorized (server/registry.ts, under
// manage-engagement / engagement scope); it never reads firm_id from a request
// body. The underlying reads (verification, data-room, scoring, advisory) are the
// same the platform already exposes, scoped by the caller.
import type pg from 'pg';
import { verificationSummary } from '../verification';
import { listDataRoom } from '../data-room';
import { explainAssessment } from '../scoring';
import { fireAdvisoryItems } from '../advisory';
import { retrieveMarketContext, type MarketExposure } from '../market-retrieval';

// One citable passage a grounded generation may quote and attribute. Deliberately
// the shape another agent renders verbatim as an EvidenceRef ({body, cite_id,
// citation, source}); `source` is a free string here (source-agnostic) so a new
// source can be added without changing this interface.
export interface GroundedPassage {
  body: string;
  cite_id: string;
  citation: string;
  source: string;
}

export interface RetrievalResult {
  passages: GroundedPassage[];
}

// Lowercase alphanumeric tokens of length >= 2 — the keyword set used on both
// sides of the overlap ranking. Pure and deterministic.
function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2));
}

// Pure, deterministic ranking: order passages by how many DISTINCT question
// keywords appear in the passage text (body + citation), most first, and keep the
// top `limit`. Zero-overlap passages are retained (up to the limit) so a fallback
// answer always has cited evidence to show. Stable: ties keep assembly order, so
// the same inputs always yield the same ordering (no LLM, no randomness).
export function rankPassages(
  passages: GroundedPassage[],
  question: string,
  limit: number,
): GroundedPassage[] {
  const qTokens = tokenize(question);
  return passages
    .map((p, idx) => {
      const pTokens = tokenize(`${p.body} ${p.citation}`);
      let overlap = 0;
      for (const t of qTokens) if (pTokens.has(t)) overlap++;
      return { p, idx, overlap };
    })
    .sort((a, b) => b.overlap - a.overlap || a.idx - b.idx)
    .slice(0, limit)
    .map((x) => x.p);
}

// The engagement's OWN citable knowledge, ranked to a diligence question. Pulls
// four structured, already-computed sources and shapes each row into a cited
// passage; ranks by keyword overlap; returns the top `limit` (default 8). Reads
// only — computes and writes no score (rule 1). The caller has already resolved +
// authorized the engagement/assessment under its scope.
export async function engagementKnowledgeSource(
  db: pg.ClientBase,
  args: { engagementId: string; assessmentId: string; question: string; limit?: number },
): Promise<RetrievalResult> {
  const { engagementId, assessmentId, question } = args;
  const limit = args.limit ?? 8;
  const passages: GroundedPassage[] = [];

  // 1. Verified financial inputs (server/verification.ts): the figures a buyer's
  // QoE would re-verify. Only the document-/ledger-backed ones are "verified" and
  // therefore citable as proven facts; self-reported inputs are omitted.
  const verification = await verificationSummary(db, assessmentId);
  for (const input of verification.inputs) {
    if (input.source !== 'document' && input.source !== 'connected_ledger') continue;
    passages.push({
      body: `${input.prompt}: ${input.source} verified`,
      cite_id: `VF-${input.question_code}`,
      citation: `Verified financial input · ${input.source}`,
      source: 'verified_fact',
    });
  }

  // 2. Data-room items that are Ready or document-verified (server/data-room.ts):
  // the pre-built diligence evidence, cited by the buyer's own rationale.
  const dataRoom = await listDataRoom(db, engagementId);
  for (const item of dataRoom.items) {
    if (item.readiness_state !== 'ready' && item.document_status !== 'verified') continue;
    const body = item.buyer_rationale ? `${item.label}. ${item.buyer_rationale}` : item.label;
    passages.push({
      body,
      cite_id: `DR-${item.item_code}`,
      citation: `Data room · ${item.readiness_state}`,
      source: 'data_room',
    });
  }

  // 3. Fired gaps from the assessment explain trace (server/scoring.ts): the
  // deterministic weaknesses a buyer will probe. Cited so the answer stays honest.
  const explain = await explainAssessment(db, assessmentId);
  for (const gap of explain.firedGaps) {
    passages.push({
      body: `${gap.name} (severity: ${gap.severity})`,
      cite_id: `GAP-${gap.code}`,
      citation: `Assessment gap · ${gap.severity}`,
      source: 'gap',
    });
  }

  // 4. Buyer-lens advisory findings (server/advisory.ts): the questions/risks the
  // catalog fires off live scores. code can be null on firm-authored items — fall
  // back to the row id so every cite_id is stable and unique.
  const advisory = await fireAdvisoryItems(db, engagementId);
  for (const item of advisory.items) {
    passages.push({
      body: `${item.title}. ${item.body}`,
      cite_id: `ADV-${item.code ?? item.id}`,
      citation: `Advisory finding · ${item.severity ?? item.item_type}`,
      source: 'advisory',
    });
  }

  return { passages: rankPassages(passages, question, limit) };
}

// Thin wrapper over the market RAG (server/market-retrieval.ts) so licensed market
// context is retrievable behind the SAME interface as engagement knowledge. Behavior
// is unchanged; each market passage is tagged source 'market'. Optional to call —
// the Q&A answer path grounds on engagement knowledge and may add this when a
// market lens is wanted.
export async function marketSource(
  db: pg.ClientBase,
  args: {
    industryKey: string;
    sizeBand?: string | null;
    exposure?: MarketExposure;
    question?: string;
    limit?: number;
  },
): Promise<RetrievalResult> {
  const { passages } = await retrieveMarketContext(db, {
    industryKey: args.industryKey,
    sizeBand: args.sizeBand,
    exposure: args.exposure,
    query: args.question,
    limit: args.limit,
  });
  return {
    passages: passages.map((p) => ({
      body: p.body,
      cite_id: p.cite_id,
      citation: p.citation,
      source: 'market',
    })),
  };
}
