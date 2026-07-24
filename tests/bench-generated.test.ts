// ExitBlueprint Bench — generated tier, HERMETIC checks (no DB, no API key).
// The DB-backed generated grader (scoreGeneratedDeliverable / runGeneratedBench)
// needs a live database and is exercised on the guarded ci.ts path; it cannot run
// here. What this test locks WITHOUT a DB is the DATA half of that tier:
//   1. the new rubrics (delta_report / cim / teaser) parse and are well-formed;
//   2. the existing pure gradeDeliverable, applied to the CIM rubric over inline
//      CIM-like markdown, correctly FAILS the no-valuation criterion when a "$"
//      figure is present, and passes when the markdown is strengths-only.
// This is the buyer-facing firewall the CIM must never breach (a CIM invites
// bids; it never states a price), asserted on output the same way ci.ts will.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gradeDeliverable, type BenchRubric } from '../server/llm/evals/bench';

const rubricsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'server',
  'llm',
  'evals',
  'rubrics',
);

function loadRubric(name: string): BenchRubric {
  return JSON.parse(readFileSync(join(rubricsDir, name), 'utf8')) as BenchRubric;
}

describe('generated-tier rubrics parse', () => {
  for (const [file, docType] of [
    ['delta_report.baseline.json', 'delta_report'],
    ['cim.baseline.json', 'cim'],
    ['teaser.baseline.json', 'teaser'],
  ] as const) {
    it(`${file} is a well-formed rubric for ${docType}`, () => {
      const r = loadRubric(file);
      expect(r.docType).toBe(docType);
      expect(Array.isArray(r.answer)).toBe(true);
      expect(Array.isArray(r.source)).toBe(true);
      expect(r.answer.length).toBeGreaterThan(0);
      // Every criterion carries the fields the grader dispatches on.
      for (const c of [...r.answer, ...r.source]) {
        expect(typeof c.id).toBe('string');
        expect(['positive', 'negative']).toContain(c.kind);
        expect(['answer', 'source']).toContain(c.axis);
        expect(typeof c.check.type).toBe('string');
      }
    });
  }
});

// A payload modeled on buildCimPayload's shape (server/cim.ts): strengths-only,
// so the CIM rubric's positive criteria have something to trace to.
const cimPayload = {
  company: { name: 'Acme Field Co', industry: 'Field Services', state: 'TX' },
  highlights: [
    { area: 'Recurring Revenue', facts: ['Multi-year contracts cover most of the base'] },
    { area: 'Operational Maturity', facts: ['Documented processes across the field crews'] },
  ],
  financial: {
    adjusted_ebitda: null,
    reported_ebitda: null,
    adjusted_ebitda_display: null,
    reported_ebitda_display: null,
  },
  verified_evidence: ['Signed customer agreements', 'Trailing twelve-month financials'],
  sections: [{ code: 'HIGHLIGHTS', name: 'Investment Highlights', guidance: '' }],
};

describe('CIM rubric on inline markdown (no-valuation firewall)', () => {
  const rubric = loadRubric('cim.baseline.json');

  // Strengths-only CIM: leads with investment highlights, no price, no DRS, no
  // gap/weakness, no numerals.
  const strengthsOnly = `# Confidential Information Memorandum — Acme Field Co

_Confidential. Provided under a confidentiality agreement for evaluation only._

## Investment Highlights
- **Recurring Revenue.** Multi-year contracts cover most of the base.
- **Operational Maturity.** Documented processes across the field crews.

No asking price is stated in this memorandum.
`;

  it('passes a strengths-only CIM (no-valuation criterion does not fire)', () => {
    const s = gradeDeliverable(strengthsOnly, cimPayload, rubric);
    expect(s.failures.some((f) => f.includes('no-valuation'))).toBe(false);
    // Nothing forbidden fired and both highlights trace, so it grades clean.
    expect(s.answerScore).toBe(1);
    expect(s.sourceScore).toBe(1);
  });

  it('FAILS the no-valuation criterion when a "$" figure is present', () => {
    const withDollar =
      strengthsOnly + '\nOn a normalized basis we estimate a $5.2M enterprise value.\n';
    const s = gradeDeliverable(withDollar, cimPayload, rubric);
    expect(s.failures.some((f) => f.includes('no-valuation'))).toBe(true);
    expect(s.answerScore).toBeLessThan(1);
  });
});
