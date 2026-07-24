// ExitBlueprint Bench (docs/sellside-ai/02): the deterministic deliverable
// grader. These are pure unit tests over inline fixtures — no disk, no DB, no
// API key — so they assert the SCORING FORMULAS directly:
//   - a clean deliverable scores answer ~1 / source 1;
//   - a hallucinated number drops the answer score via the numeral firewall;
//   - a "$5.2M valuation" sentence trips the must_not_contain firewall;
//   - dropping the top-gap mention drops BOTH answer completeness and source
//     traceability (the same fact feeds both axes on different criteria).
import { describe, expect, it } from 'vitest';
import { gradeDeliverable, type BenchRubric } from '../server/llm/evals/bench';

// A small payload modeled on buildOwnerReportPayload's shape.
const payload = {
  company: { name: 'Acme Field Co', industry: 'Field Services' },
  overall_score: 58,
  band: 'Developing',
  owner_readiness_index: 64,
  dimensions: [{ name: 'Financial Hygiene', score: 52, meaning: 'Weighted 0.25 of the overall score' }],
  top_gaps: [
    { name: 'Financial Reporting Quality', severity: 'critical' },
    { name: 'Customer Concentration', severity: 'high' },
  ],
  flags: [],
  prior_comparison: null,
};

// Rubric mirrors rubrics/owner_report.baseline.json: three positive answer
// criteria (weights 3/2/2), two negative firewalls (5/4), two source
// traceability criteria (1/1).
const rubric: BenchRubric = {
  docType: 'owner_report',
  answer: [
    {
      id: 'names-top-gap',
      weight: 3,
      kind: 'positive',
      axis: 'answer',
      description: 'states the highest-severity gap by name',
      check: { type: 'payload_field_present_in_output', path: 'top_gaps.0.name' },
    },
    {
      id: 'states-band',
      weight: 2,
      kind: 'positive',
      axis: 'answer',
      description: 'states the readiness band',
      check: { type: 'payload_field_present_in_output', path: 'band' },
    },
    {
      id: 'explains-whats-next',
      weight: 2,
      kind: 'positive',
      axis: 'answer',
      description: 'explains what happens next',
      check: { type: 'must_contain_any', phrases: ['what happens next', 're-assess', 'advisor will'] },
    },
    {
      id: 'no-hallucinated-number',
      weight: 5,
      kind: 'negative',
      axis: 'answer',
      description: 'numeral firewall',
      check: { type: 'no_hallucinated_number' },
    },
    {
      id: 'no-valuation',
      weight: 4,
      kind: 'negative',
      axis: 'answer',
      description: 'no dollar valuation or multiple in an owner report',
      check: { type: 'must_not_contain', patterns: ['\\$', 'valuation', 'multiple'] },
    },
  ],
  source: [
    {
      id: 'top-gap-traceable',
      weight: 1,
      kind: 'positive',
      axis: 'source',
      description: 'top gap traces to a payload entry',
      check: { type: 'payload_field_present_in_output', path: 'top_gaps.0.name' },
    },
    {
      id: 'second-gap-traceable',
      weight: 1,
      kind: 'positive',
      axis: 'source',
      description: 'second gap traces to a payload entry',
      check: { type: 'payload_field_present_in_output', path: 'top_gaps.1.name' },
    },
  ],
};

// A clean deliverable: names both gaps, states the band, explains next steps,
// uses only payload numbers, no dollar figure or multiple.
const cleanMarkdown = `# Exit Readiness Report — Acme Field Co

Your Diligence Readiness Score is 58, placing you in the Developing tier.
Your Owner Readiness Index is 64, measured separately.

## What to fix first

### Financial Reporting Quality
Flagged as a critical priority. Financial Hygiene scored 52, the clearest drag.

### Customer Concentration
Flagged as a high priority. Broaden the account base over time.

## What happens next
Your advisor will work these priorities with you, then re-assess.
`;

describe('gradeDeliverable', () => {
  it('scores a clean deliverable answer ~1 and source 1', () => {
    const s = gradeDeliverable(cleanMarkdown, payload, rubric);
    expect(s.answerScore).toBeCloseTo(1, 5);
    expect(s.answerScoreRaw).toBeCloseTo(1, 5);
    expect(s.sourceScore).toBe(1);
    expect(s.failures).toEqual([]);
  });

  it('drops the answer score when a hallucinated number appears', () => {
    // 42 is not in the payload, so the numeral firewall (weight 5) fires.
    const dirty = cleanMarkdown + '\nRetention improved by 42 percent last year.\n';
    const s = gradeDeliverable(dirty, payload, rubric);
    // raw = (7 earned − 5 incurred) / 7 available = 2/7
    expect(s.answerScoreRaw).toBeCloseTo(2 / 7, 5);
    expect(s.answerScore).toBeLessThan(1);
    expect(s.failures.some((f) => f.includes('no-hallucinated-number'))).toBe(true);
    // The hallucination does not touch traceability.
    expect(s.sourceScore).toBe(1);
  });

  it('trips must_not_contain on a dollar valuation sentence', () => {
    const dirty = cleanMarkdown + '\nWe estimate a $5.2M valuation at exit.\n';
    const s = gradeDeliverable(dirty, payload, rubric);
    expect(s.answerScore).toBeLessThan(1);
    expect(s.failures.some((f) => f.includes('no-valuation'))).toBe(true);
    // "$" and "valuation" both match the same negative criterion; 5.2 is also a
    // hallucinated number, so the numeral firewall fires too.
    expect(s.failures.some((f) => f.includes('no-hallucinated-number'))).toBe(true);
  });

  it('drops both answer completeness and source traceability when the top gap is unmentioned', () => {
    // Remove every mention of the highest-severity gap name.
    const withoutTopGap = cleanMarkdown.replace(/Financial Reporting Quality/g, 'that issue');
    const s = gradeDeliverable(withoutTopGap, payload, rubric);
    // answer: the 3-weight names-top-gap positive is no longer earned.
    // raw = (4 earned of 7 available) / 7
    expect(s.answerScoreRaw).toBeCloseTo(4 / 7, 5);
    expect(s.failures.some((f) => f.includes('answer: names-top-gap'))).toBe(true);
    // source: the same fact feeds top-gap-traceable, so source drops to 1/2.
    expect(s.sourceScore).toBe(0.5);
    expect(s.failures.some((f) => f.includes('source: top-gap-traceable'))).toBe(true);
  });
});
