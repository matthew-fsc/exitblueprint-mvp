// The findings engine: buy-side diligence patterns run in reverse against the
// graph. A pattern is a module — key, description, severity, a match function
// that queries graph_nodes/edges and returns evidence, and the prompt that
// drafts its narrative. Narrative generation is gated: any drafted number not
// present in the evidence is rejected (numbers come from the graph, never the LLM).
import type pg from 'pg';
import type { FindingSeverity, GraphEvidence } from '../../shared/intelligence/schemas';
import type { LlmClient } from '../llm/client';

export interface MatchContext {
  db: pg.ClientBase;
  engagementId: string;
}

export interface FindingMatch {
  severity: FindingSeverity;
  evidence: GraphEvidence;
}

export interface FindingPattern {
  patternKey: string;
  description: string;
  match: (ctx: MatchContext) => Promise<FindingMatch[]>;
  narrativePromptKey: string;
}

// customer_concentration: a single customer above 25% of revenue is a buyer's
// first concentration flag. Matches the top customer node by revenue_pct.
export const customerConcentration: FindingPattern = {
  patternKey: 'customer_concentration',
  description: 'A single customer accounts for more than 25% of revenue.',
  narrativePromptKey: 'finding.narrative.v1',
  async match({ db, engagementId }) {
    const rows = await db.query(
      `select id, attributes->>'name' as name,
              (attributes->>'revenue_pct')::numeric as pct
         from graph_nodes
        where engagement_id = $1 and node_type = 'Customer'
          and attributes ? 'revenue_pct'
        order by pct desc nulls last
        limit 1`,
      [engagementId],
    );
    if (rows.rowCount === 0) return [];
    const top = rows.rows[0];
    const pct = top.pct === null ? 0 : Number(top.pct);
    if (pct <= 0.25) return [];
    const severity: FindingSeverity = pct > 0.4 ? 'critical' : pct > 0.3 ? 'high' : 'medium';
    return [
      {
        severity,
        evidence: {
          nodes: [top.id as string],
          edges: [],
          facts: {
            top_customer_name: top.name ?? 'unknown',
            top_customer_pct: pct,
          },
        },
      },
    ];
  },
};

export const PATTERN_REGISTRY: Record<string, FindingPattern> = {
  [customerConcentration.patternKey]: customerConcentration,
};

// --- Narrative guard ----------------------------------------------------------

const NUMBER_RE = /-?\$?\d[\d,]*(?:\.\d+)?%?/g;

function normalizeNumber(token: string): number | null {
  const cleaned = token.replace(/[$,%]/g, '');
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

// Numbers the narrative is allowed to state: the evidence's numeric facts, plus
// their percent form (0.32 -> 32) since a ratio is often rendered as a percent.
function allowedNumbers(evidence: GraphEvidence): Set<number> {
  const allowed = new Set<number>();
  for (const v of Object.values(evidence.facts)) {
    if (typeof v === 'number') {
      allowed.add(v);
      if (v > 0 && v <= 1) allowed.add(Math.round(v * 100));
    } else {
      const n = normalizeNumber(v);
      if (n !== null) allowed.add(n);
    }
  }
  return allowed;
}

export interface GuardResult {
  ok: boolean;
  offending: string[];
}

// Reject a narrative that asserts a number not backed by the evidence. A small
// tolerance covers percent rounding (32% for 0.324).
export function checkNarrativeNumbers(text: string, evidence: GraphEvidence): GuardResult {
  const allowed = allowedNumbers(evidence);
  const offending: string[] = [];
  for (const token of text.match(NUMBER_RE) ?? []) {
    const n = normalizeNumber(token);
    if (n === null) continue;
    const matched = [...allowed].some((a) => Math.abs(a - n) < 0.5 || Math.abs(a - n * 100) < 0.5);
    if (!matched) offending.push(token);
  }
  return { ok: offending.length === 0, offending };
}

// Draft a finding's narrative from its evidence, then enforce the guard. Throws
// if the model introduced an unsupported number — the caller keeps the finding
// without an approved narrative rather than persisting a fabricated one.
export async function generateFindingNarrative(
  llm: LlmClient,
  pattern: FindingPattern,
  match: FindingMatch,
  opts: { firmId?: string | null; engagementId?: string | null } = {},
): Promise<string> {
  const result = await llm.call({
    promptKey: pattern.narrativePromptKey,
    vars: {
      patternDescription: pattern.description,
      evidenceJson: JSON.stringify(match.evidence),
    },
    firmId: opts.firmId,
    engagementId: opts.engagementId,
  });
  const guard = checkNarrativeNumbers(result.text, match.evidence);
  if (!guard.ok) {
    throw new Error(
      `finding narrative asserted unsupported numbers: ${guard.offending.join(', ')}`,
    );
  }
  return result.text;
}
