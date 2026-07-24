// Engagement-graph BRIEF — the narrative half of the engagement graph (docs/09
// moat 3, "the engagement graph"; WS-GRAPH).
//
// server/engagement-graph.ts computes remediation effectiveness DETERMINISTICALLY
// and with NO narrative: for each cleared gap it reports how much the DRS moved,
// how much that gap's own dimension moved, and — where a deal later closed — the
// final multiple. This module leaves that computation untouched and adds the
// reasoning agent that NARRATES it: it wraps the graph (plus an optional firm
// calibration summary) in a labeled draft an advisor can read as "gaps like these
// moved the DRS by about X, and the deals that cleared them closed around Y."
//
// CLAUDE.md rules 1 & 2, restated so they can never be lost — this is the same
// boundary server/institutional-review.ts enforces:
//   * The AI NEVER computes, adjusts, influences, or grades a score. Every number
//     comes from the deterministic engagement graph, is placed in the payload
//     server-side, and is the ONLY number the model may use (the numeral firewall
//     in the shared runtime rejects any numeral the payload did not contain).
//   * Output is always a LABELED DRAFT carrying a prompt_version. The brief reads
//     the firm's own record back; it does not decide, price, or score.
//   * Injectable generator: Claude via the AI gateway when configured, otherwise a
//     deterministic composer over the graph numbers, so a brief always generates
//     and tests stay key-free (identical seam to institutional-review.ts).
//
// Read-only: it writes to NO table (persist 'none' in the agent registry) and
// returns an in-memory labeled-draft artifact.
import type pg from 'pg';
import { runGroundedGeneration, withDraftBanner, type GenerateFn } from './intelligence/runtime';
import { engagementGraph, type EngagementGraph, type GapEffectiveness } from './engagement-graph';
import { firmCalibration, type DealCalibration } from './outcomes';
import { getAgentOrThrow } from './agents/registry';

// prompt_version + rule-based-model label come from the agent registry (the single
// source of truth) rather than local literals — mirrors diligence-qa.ts /
// institutional-review.ts. The key is a fixed literal owned by this generator; a
// miss is a programming error that should fail loudly at module load.
const BRIEF_AGENT = getAgentOrThrow('engagement_graph_brief');
export const PROMPT_VERSION = BRIEF_AGENT.promptVersion; // 'engagement_graph_brief.v1'
export const RULE_BASED_MODEL = BRIEF_AGENT.ruleBasedModel; // 'rule-based:engagement_graph_brief.v1'

// The unmissable label on every brief, AI- or rule-composed. It carries no
// numeral, so prepending it never trips the numeral firewall.
export const DRAFT_BANNER =
  '_DRAFT — Engagement Graph brief. AI-assisted narrative assembled for advisor ' +
  'review only. It reads back your firm’s own remediation record and grades ' +
  'nothing: every figure it cites was produced by the deterministic engagement ' +
  'graph. Averages are directional patterns across past clears, not a forecast for ' +
  'any new deal._';

// --- Payload (the only numbers the model may use) ------------------------------

// A firm-wide calibration summary carried alongside the graph as optional extra
// facts. Kept to the two figures the brief can honestly reference (closed-deal
// count + average final multiple); the rest of DealCalibration is out of scope.
export interface BriefCalibration {
  closed: number;
  avg_final_multiple: number | null;
}

// Everything the brief may reason over — assembled entirely from deterministic
// output. No recomputation; the model reads this and nothing else.
export interface EngagementGraphBriefPayload {
  firm_id: string;
  gaps_cleared: number; // comparable (same-rubric) clears across all gaps
  incomparable_clears: number; // cross-rubric clears — counted, never averaged
  effectiveness: GapEffectiveness[]; // most DRS movement first (from the graph)
  // Optional firm-wide deal summary; null/omitted when calibration is unavailable.
  calibration: BriefCalibration | null;
}

// Pure: fold the deterministic graph (and optional calibration) into the brief
// payload. Computes no score and derives no new number — it only reshapes the
// deterministic output the graph already produced. Testable without a database.
export function assembleBriefPayload(
  graph: EngagementGraph,
  calibration?: DealCalibration | null,
): EngagementGraphBriefPayload {
  return {
    firm_id: graph.firm_id,
    gaps_cleared: graph.gaps_cleared,
    incomparable_clears: graph.incomparable_clears,
    effectiveness: graph.effectiveness,
    calibration: calibration
      ? { closed: calibration.closed, avg_final_multiple: calibration.avg_final_multiple }
      : null,
  };
}

// Build the payload from persisted deterministic results. Reads the engagement
// graph (unchanged) and the firm calibration summary (optional extra facts); both
// are read-only and never write a score. firmId is the caller's trusted firm
// (firm scope), resolved upstream, never taken from a request body.
export async function buildEngagementGraphBriefPayload(
  db: pg.ClientBase,
  firmId: string,
): Promise<EngagementGraphBriefPayload> {
  const graph = await engagementGraph(db, firmId);
  // Calibration is a best-effort enrichment: if it is unavailable for any reason
  // the brief still stands on the graph alone, so a failure here degrades to null
  // rather than failing the whole brief.
  let calibration: DealCalibration | null = null;
  try {
    calibration = await firmCalibration(db, firmId);
  } catch {
    calibration = null;
  }
  return assembleBriefPayload(graph, calibration);
}

// --- Deterministic composer (no API key required) -------------------------------
// Rule-based brief assembled from the payload alone — invents nothing, computes
// nothing (CLAUDE.md rule 1/2-safe). Every numeral it emits is a payload numeral,
// so numeralPostCheck(composeEngagementGraphBrief(p), p) is empty by construction.
// It never states a count it derived itself (e.g. the length of the list); it uses
// only the counts the payload carries. Always available (demos, key-less
// environments) and fully defensible.
export function composeEngagementGraphBrief(payload: EngagementGraphBriefPayload): string {
  const lines: string[] = [];

  lines.push('# Engagement graph — remediation effectiveness');
  lines.push('');
  lines.push(DRAFT_BANNER);
  lines.push('');
  lines.push(
    'This brief reads your firm’s own remediation record back to you. It grades ' +
      'nothing and forecasts nothing: every figure below was produced by the ' +
      'deterministic engagement graph, and the averages are directional patterns ' +
      'across past clears.',
  );
  lines.push('');

  // 1. What has cleared.
  lines.push('## What has cleared');
  if (payload.gaps_cleared === 0) {
    lines.push(
      'No gaps have yet been cleared and re-measured on the same rubric, so there is ' +
        'nothing to read back yet. The brief becomes useful once a flagged gap is ' +
        'resolved and the engagement is reassessed.',
    );
    if (payload.incomparable_clears > 0) {
      lines.push('');
      lines.push(
        `${payload.incomparable_clears} clear(s) happened across a rubric-version change and ` +
          'are counted but not averaged, because the scores sit on different scales.',
      );
    }
    return withDraftBanner(lines.join('\n'), DRAFT_BANNER);
  }
  lines.push(
    `${payload.gaps_cleared} comparable, same-rubric clear(s) drive the figures below. ` +
      'Only clears whose resolving and prior assessments share a rubric version are ' +
      'averaged, so the movements are like-for-like.',
  );
  if (payload.incomparable_clears > 0) {
    lines.push('');
    lines.push(
      `A further ${payload.incomparable_clears} clear(s) crossed a rubric-version change; ` +
        'they are counted but not averaged, because the scales differ.',
    );
  }
  lines.push('');

  // 2. Gaps that moved the score — walk the list in the order the graph gave.
  lines.push('## Gaps that moved the score');
  for (const g of payload.effectiveness) {
    lines.push(gapSentence(g));
  }
  lines.push('');

  // 3. Where deals followed.
  lines.push('## Where deals followed');
  const closers = payload.effectiveness.filter((g) => g.deals_closed > 0 && g.avg_final_multiple != null);
  if (closers.length === 0) {
    lines.push(
      'None of the cleared gaps yet trace to a closed deal with a recorded multiple, so ' +
        'there is no outcome pattern to read here.',
    );
  } else {
    for (const g of closers) {
      lines.push(
        `- After clearing **${g.gap_name}**, ${g.deals_closed} deal(s) later closed, around a ` +
          `${g.avg_final_multiple} average final multiple. That is what those deals closed ` +
          'around, not a prediction for a new one.',
      );
    }
  }
  if (payload.calibration && payload.calibration.closed > 0 && payload.calibration.avg_final_multiple != null) {
    lines.push('');
    lines.push(
      `Across the book, ${payload.calibration.closed} deal(s) have closed at a ` +
        `${payload.calibration.avg_final_multiple} average final multiple.`,
    );
  }
  lines.push('');

  // 4. For the advisor.
  lines.push('## For the advisor');
  lines.push(
    'Use the ranking above as a prioritization signal: the gaps at the top are the ones ' +
      'your book has seen move the score most when cleared. Keep the framing directional, ' +
      'and refer any legal or tax structure questions to counsel; this brief does not opine ' +
      'on them.',
  );

  return withDraftBanner(lines.join('\n'), DRAFT_BANNER);
}

// One effectiveness row as a sentence. Emits only the payload's own numerals
// (avg_drs_delta, avg_dimension_delta, clears), so it is numeral-firewall-safe.
function gapSentence(g: GapEffectiveness): string {
  const head = `- **${g.gap_name}** (${g.severity}, ${g.dimension_code})`;
  if (g.avg_drs_delta == null) {
    return `${head}: cleared ${g.clears} time(s), but without a comparable same-rubric movement to average yet.`;
  }
  const dim =
    g.avg_dimension_delta == null
      ? ''
      : ` and about ${g.avg_dimension_delta} on its own ${g.dimension_code} dimension`;
  return (
    `${head}: moved the DRS by about ${g.avg_drs_delta}${dim} on average, across ` +
    `${g.clears} comparable clear(s).`
  );
}

// --- Brief generation (injectable generator + numeral firewall) -----------------

export interface EngagementGraphBrief {
  doc_type: 'engagement_graph_brief';
  prompt_version: string;
  model: string;
  is_draft: true; // always — this seam only ever produces draft narrative
  content_md: string;
  payload: EngagementGraphBriefPayload;
}

// Build the payload, then produce the labeled draft brief. Generator selection is
// owned by the shared runtime and matches the other reasoning agents exactly: an
// explicit generator forces the strict AI path (tests); otherwise Claude via the
// gateway when configured, falling back to the deterministic composer on any AI
// failure — so a brief always generates, even with no gateway balance. Read-only:
// returns the artifact, writes nothing.
export async function generateEngagementGraphBrief(
  db: pg.ClientBase,
  firmId: string,
  generate?: GenerateFn,
): Promise<EngagementGraphBrief> {
  const payload = await buildEngagementGraphBriefPayload(db, firmId);

  const { text, model } = await runGroundedGeneration({
    db,
    promptVersion: PROMPT_VERSION,
    ruleBasedModel: RULE_BASED_MODEL,
    modelTier: BRIEF_AGENT.modelTier,
    userContent: `Engagement graph data (JSON):\n${JSON.stringify(payload, null, 2)}`,
    compose: () => composeEngagementGraphBrief(payload),
    draftBanner: DRAFT_BANNER,
    generate,
    label: 'engagement graph brief',
    regenInstruction: 'Use only numbers from the payload, and never compute a number of your own.',
  });

  return {
    doc_type: 'engagement_graph_brief',
    prompt_version: PROMPT_VERSION,
    model,
    is_draft: true,
    content_md: text,
    payload,
  };
}
