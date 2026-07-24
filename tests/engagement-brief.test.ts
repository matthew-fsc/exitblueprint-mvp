// Engagement-graph BRIEF (WS-GRAPH, docs/09 moat 3): the reasoning agent that
// NARRATES the deterministic engagement graph as a LABELED DRAFT and never grades,
// computes, or adjusts a score (CLAUDE.md rules 1-2).
//
// DB-free and key-free: the pure assembler/composer are exercised directly over a
// hand-built graph, and the generation path is driven with an injected fake
// generator over a fake db.query — the same pattern tests/institutional-review.ts
// uses. The guarantees under test: draft labeling is always present, no invented
// number survives the numeral firewall, the agent's constants are sourced FROM the
// registry, and the deterministic composer stands in with no API key.
import { describe, expect, it, vi } from 'vitest';
import {
  assembleBriefPayload,
  composeEngagementGraphBrief,
  generateEngagementGraphBrief,
  DRAFT_BANNER,
  PROMPT_VERSION,
  RULE_BASED_MODEL,
  type EngagementGraphBriefPayload,
} from '../server/engagement-brief';
import { numeralPostCheck } from '../server/intelligence/guards';
import { getAgent } from '../server/agents/registry';
import type { EngagementGraph } from '../server/engagement-graph';
import type { DealCalibration } from '../server/outcomes';
import type { GeneratedText } from '../server/intelligence/runtime';

// --- Fixtures ------------------------------------------------------------------

// A rich, deterministic engagement graph: a gap with movement + a closed deal, a
// gap with movement but no deal, and a gap cleared without a comparable movement.
const graph: EngagementGraph = {
  firm_id: 'f1',
  gaps_cleared: 6,
  incomparable_clears: 2,
  effectiveness: [
    {
      gap_code: 'OWNER_DEP',
      gap_name: 'Owner Dependence',
      dimension_code: 'OWN',
      severity: 'critical',
      clears: 3,
      incomparable_clears: 1,
      avg_drs_delta: 0.4,
      avg_dimension_delta: 1.25,
      deals_closed: 2,
      avg_final_multiple: 5.5,
    },
    {
      gap_code: 'CUST_CONC',
      gap_name: 'Customer Concentration',
      dimension_code: 'REV',
      severity: 'high',
      clears: 2,
      incomparable_clears: 0,
      avg_drs_delta: 0.2,
      avg_dimension_delta: null,
      deals_closed: 0,
      avg_final_multiple: null,
    },
    {
      gap_code: 'RECON_GAP',
      gap_name: 'Reconciliation Discipline Gap',
      dimension_code: 'FIN',
      severity: 'med',
      clears: 1,
      incomparable_clears: 1,
      avg_drs_delta: null,
      avg_dimension_delta: null,
      deals_closed: 0,
      avg_final_multiple: null,
    },
  ],
};

const calibration: DealCalibration = {
  deals_recorded: 4,
  closed: 2,
  broken: 1,
  withdrawn: 1,
  with_prediction: 2,
  avg_ev_variance_pct: 3.1,
  within_range_pct: 50,
  avg_final_multiple: 5.5,
  avg_days_on_market: 180,
  retrade_rate_pct: 25,
  deals: [],
};

// --- Pure assembler ------------------------------------------------------------

describe('assembleBriefPayload (pure)', () => {
  it('carries the graph numbers through verbatim and derives no new number', () => {
    const p = assembleBriefPayload(graph, calibration);
    expect(p.gaps_cleared).toBe(6);
    expect(p.incomparable_clears).toBe(2);
    expect(p.effectiveness).toHaveLength(3);
    // reduces calibration to the two figures the brief may reference
    expect(p.calibration).toEqual({ closed: 2, avg_final_multiple: 5.5 });
    // every numeral in the assembled payload traces to a source numeral
    expect(numeralPostCheck(JSON.stringify(p), { graph, calibration })).toEqual([]);
  });

  it('tolerates missing calibration (graph stands alone)', () => {
    const p = assembleBriefPayload(graph, null);
    expect(p.calibration).toBeNull();
    expect(p.gaps_cleared).toBe(6);
  });
});

// --- Deterministic composer ----------------------------------------------------

describe('composeEngagementGraphBrief (pure, firewall-clean)', () => {
  const payload = assembleBriefPayload(graph, calibration);

  it('labels the brief as draft and never claims to grade', () => {
    const md = composeEngagementGraphBrief(payload);
    expect(md).toContain('# Engagement graph — remediation effectiveness');
    expect(md).toContain(DRAFT_BANNER);
    expect(md.toLowerCase()).toContain('grades nothing');
  });

  it('walks the effectiveness list in the graph order and names each gap', () => {
    const md = composeEngagementGraphBrief(payload);
    expect(md).toContain('## Gaps that moved the score');
    expect(md).toContain('Owner Dependence');
    expect(md).toContain('Customer Concentration');
    // a gap without a comparable movement is stated plainly, not implied away
    expect(md).toContain('Reconciliation Discipline Gap');
    expect(md).toContain('without a comparable same-rubric movement');
    // the ordering: highest DRS mover first
    expect(md.indexOf('Owner Dependence')).toBeLessThan(md.indexOf('Customer Concentration'));
  });

  it('reports where deals followed, framed as what closed around (not a forecast)', () => {
    const md = composeEngagementGraphBrief(payload);
    expect(md).toContain('## Where deals followed');
    expect(md).toContain('5.5'); // the average final multiple, verbatim from the payload
    expect(md.toLowerCase()).toContain('not a prediction');
  });

  it('emits no numeral absent from the payload (numeral firewall clean)', () => {
    const md = composeEngagementGraphBrief(payload);
    expect(numeralPostCheck(md, payload)).toEqual([]);
  });

  it('is numeral-firewall clean with no calibration too', () => {
    const p = assembleBriefPayload(graph, null);
    expect(numeralPostCheck(composeEngagementGraphBrief(p), p)).toEqual([]);
  });

  it('degrades cleanly when nothing has cleared', () => {
    const empty: EngagementGraphBriefPayload = {
      firm_id: 'f1',
      gaps_cleared: 0,
      incomparable_clears: 0,
      effectiveness: [],
      calibration: null,
    };
    const md = composeEngagementGraphBrief(empty);
    expect(md).toContain(DRAFT_BANNER);
    expect(md.toLowerCase()).toContain('no gaps have yet been cleared');
    expect(numeralPostCheck(md, empty)).toEqual([]);
  });

  it('is deterministic (same payload → same brief)', () => {
    expect(composeEngagementGraphBrief(payload)).toBe(composeEngagementGraphBrief(payload));
  });
});

// --- Registry sourcing ---------------------------------------------------------

describe('engagement_graph_brief resolves from the agent registry', () => {
  it('sources its prompt_version and rule-based model FROM the registry entry', () => {
    const agent = getAgent('engagement_graph_brief');
    expect(agent).toBeDefined();
    expect(agent?.engine).toBe('reasoning');
    expect(agent?.scope).toBe('firm');
    expect(agent?.persist).toBe('none');
    expect(agent?.guards).toEqual(expect.arrayContaining(['numeral_firewall', 'draft_label']));
    // the module constants are the registry's values, not local literals
    expect(PROMPT_VERSION).toBe(agent?.promptVersion);
    expect(RULE_BASED_MODEL).toBe(agent?.ruleBasedModel);
    expect(PROMPT_VERSION).toBe('engagement_graph_brief.v1');
    expect(RULE_BASED_MODEL).toBe('rule-based:engagement_graph_brief.v1');
  });
});

// --- Generation path over a fake db + injected fake generator -------------------
// The fake db answers exactly the two reads buildEngagementGraphBriefPayload
// issues: the engagement graph query and the firm-calibration query. No real
// database, no API key.

function fakeDb(graphRows: unknown[], calibrationRows: unknown[]) {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return {
    query: vi.fn(async (sql: string) => {
      const q = norm(sql);
      if (q.includes('from gaps g') && q.includes('join lateral')) {
        return { rows: graphRows, rowCount: graphRows.length };
      }
      if (q.includes('from deal_outcomes d')) {
        return { rows: calibrationRows, rowCount: calibrationRows.length };
      }
      throw new Error(`unexpected query: ${q.slice(0, 60)}`);
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('generateEngagementGraphBrief (fake db + injected generator)', () => {
  it('returns an AI-path labeled draft when a generator is supplied', async () => {
    // The AI draft only states numbers that are in the (empty-graph) payload, so it
    // clears the numeral firewall. The banner is added by the runtime.
    const generate = vi.fn(
      async (): Promise<GeneratedText> => ({
        text: 'No gaps have cleared yet, so there is nothing to read back.',
        model: 'claude-opus-4-8',
      }),
    );
    const brief = await generateEngagementGraphBrief(fakeDb([], []), 'f1', generate);
    expect(brief.doc_type).toBe('engagement_graph_brief');
    expect(brief.is_draft).toBe(true);
    expect(brief.prompt_version).toBe(PROMPT_VERSION);
    expect(brief.model).toBe('claude-opus-4-8');
    expect(brief.content_md.startsWith(DRAFT_BANNER)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('holds the numeral firewall: an invented number is rejected after one retry', async () => {
    // A generator that keeps emitting a number absent from the payload must be
    // rejected — the firewall regenerates once, then hard-throws (rules 1-2).
    const generate = vi.fn(
      async (): Promise<GeneratedText> => ({
        text: 'These gaps moved the DRS by about 9999 points on average.',
        model: 'claude-opus-4-8',
      }),
    );
    await expect(generateEngagementGraphBrief(fakeDb([], []), 'f1', generate)).rejects.toThrow(
      /numerals not present in the input payload/,
    );
    expect(generate).toHaveBeenCalledTimes(2); // original + one regeneration
  });

  it('falls back to the deterministic composer with no generator and no key', async () => {
    // No injected generator and no AI gateway configured → the composer runs and the
    // draft is stamped with the rule-based model label.
    const brief = await generateEngagementGraphBrief(fakeDb([], []), 'f1');
    expect(brief.model).toBe(RULE_BASED_MODEL);
    expect(brief.content_md).toContain(DRAFT_BANNER);
    expect(brief.content_md).toContain('# Engagement graph — remediation effectiveness');
  });
});
