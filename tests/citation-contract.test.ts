// Citation contract post-check (docs/sellside-ai/01, "The citation contract").
// Pure, hermetic (no DB): the source-score guard that verifies every MARKET
// numeral in a deliverable is rendered adjacent to its passage's citation.
//
// WS-DELIVERABLES extends this to lock the wired citation contract on the
// market-facing deliverables: the CIM/teaser/management composers render every
// retrieved market figure beside its [cite_id] (citation-valid + numeral-firewall
// -safe by construction), and the Bench's uncited_market_figure source check
// grades that same property. This is the fallback half of the contract the AI path
// enforces via runGroundedGeneration's citation guard.
import { describe, expect, it } from 'vitest';
import { citationPostCheck, numeralPostCheck } from '../server/narrative';
import {
  composeCim,
  composeTeaser,
  composeManagementPresentation,
  type CimPayload,
} from '../server/cim';
import { CIM_SECTIONS } from '../shared/cim/template';
import { runCheck } from '../server/llm/evals/bench';

describe('citationPostCheck', () => {
  const marketContext = {
    passages: [
      { cite_id: 'PLACE-FS-01', body: 'Precedent transactions closed at 5.2x LTM EBITDA (n=14).' },
    ],
  };

  it('passes when a market numeral shares its line with the passage cite_id', () => {
    const md = 'Comparable deals cleared 5.2x LTM EBITDA [PLACE-FS-01].';
    expect(citationPostCheck(md, marketContext)).toEqual([]);
  });

  it('flags a market numeral stated without its cite_id on that line', () => {
    const md = 'Comparable deals cleared 5.2x LTM EBITDA.';
    expect(citationPostCheck(md, marketContext)).toEqual([
      'market figure 5.2 stated without its [PLACE-FS-01] citation',
    ]);
  });

  it('does not police numerals that are not from any passage (years, payload figures)', () => {
    // 2024 (a year) and 72.25 (a payload score) appear in no passage body.
    const md = 'Since 2024 your score of 72.25 has held steady.';
    expect(citationPostCheck(md, marketContext)).toEqual([]);
  });

  it('returns no violations when there is no market context to police', () => {
    const md = 'Comparable deals cleared 5.2x LTM EBITDA.';
    expect(citationPostCheck(md, { passages: [] })).toEqual([]);
  });
});

// --- The deterministic composers render market context, cited ------------------
// Every market figure a composer emits must sit on the same line as its [cite_id]
// (citation-valid) and be a numeral already in the payload (numeral-firewall-safe).
// Two non-colliding field-services passages, mirroring the seed (market-passages.csv).
const marketPassages = [
  {
    body: 'Sector transactions have cleared in the high-4x to mid-5x LTM EBITDA range.',
    cite_id: 'MR-FS-02',
    citation: 'Directional market reference, Q2 2026',
    source: 'market',
  },
  {
    body: 'Observed EV/EBITDA spans roughly 3.9x at the 25th percentile to 5.6x at the 75th.',
    cite_id: 'MR-FS-03',
    citation: 'Directional market reference, Q2 2026',
    source: 'market',
  },
];

// Strengths-only, no company numerals of its own, so the ONLY numerals in the
// composed output come from the cited market passages — the cleanest assertion of
// the contract.
const groundedPayload: CimPayload = {
  company: { name: 'Northwind Fabrication', industry: 'Field Services', revenue_band: null, ebitda_band: null, state: 'Ohio' },
  highlights: [{ area: 'Recurring Revenue', facts: ['Multi-year contracts cover most of the base'] }],
  financial: { adjusted_ebitda: null, reported_ebitda: null, adjusted_ebitda_display: null, reported_ebitda_display: null },
  verified_evidence: ['Signed customer agreements'],
  sections: CIM_SECTIONS.map((s) => ({ code: s.code, name: s.name, guidance: s.narrativeGuidance })),
  market_context: marketPassages,
};

describe('composers render market context, cited and firewall-safe', () => {
  const composers: [string, (p: CimPayload) => string][] = [
    ['composeCim', composeCim],
    ['composeTeaser', composeTeaser],
    ['composeManagementPresentation', composeManagementPresentation],
  ];

  for (const [name, compose] of composers) {
    it(`${name}: every market figure carries its [cite_id] and no numeral is invented`, () => {
      const md = compose(groundedPayload);
      // The market passages and their cite_ids are rendered.
      expect(md).toContain('MR-FS-02');
      expect(md).toContain('MR-FS-03');
      expect(md).toMatch(/5\.6x[^\n]*\[MR-FS-03\]/);
      // Citation contract holds: no market figure is stated without its cite_id.
      expect(citationPostCheck(md, { passages: marketPassages })).toEqual([]);
      // Numeral firewall holds: every numeral traces to the payload.
      expect(numeralPostCheck(md, groundedPayload)).toEqual([]);
    });

    it(`${name}: no market block when market_context is empty (graceful)`, () => {
      const md = compose({ ...groundedPayload, market_context: [] });
      expect(md).not.toContain('Market Context');
      expect(citationPostCheck(md, { passages: [] })).toEqual([]);
    });
  }
});

// --- The Bench uncited_market_figure source check ------------------------------
// The deterministic source-axis grader for citation traceability the cim/teaser
// rubrics now carry. It runs citationPostCheck over the payload's market_context.
describe('bench uncited_market_figure check', () => {
  const payload = { market_context: marketPassages };

  it('fires (untraceable) when a market figure is stated without its cite_id', () => {
    const md = 'The sector cleared in the high-4x to mid-5x LTM EBITDA range.';
    expect(runCheck({ type: 'uncited_market_figure' }, md, payload)).toBe(true);
  });

  it('does not fire when every market figure carries its cite_id', () => {
    const md = 'The sector cleared in the high-4x to mid-5x LTM EBITDA range [MR-FS-02].';
    expect(runCheck({ type: 'uncited_market_figure' }, md, payload)).toBe(false);
  });

  it('does not fire when the payload has no market_context (graceful)', () => {
    const md = 'The sector cleared in the high-4x to mid-5x range.';
    expect(runCheck({ type: 'uncited_market_figure' }, md, {})).toBe(false);
  });
});
