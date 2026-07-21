// CIM (Confidential Information Memorandum) — the template↔evidence mapping, the
// coverage rollup, and the deterministic composer's numeral-firewall safety.
// These lock the three things that could ship a wrong CIM silently: an evidence
// section going unmapped, the readiness math, and a composed draft that states a
// number not present in its payload.
import { describe, expect, it } from 'vitest';
import { CIM_SECTIONS, DATA_ROOM_SECTION_CODES } from '../shared/cim/template';
import {
  rollupCimCoverage,
  composeCim,
  composeTeaser,
  composeManagementPresentation,
  fmtCompactUsd,
  type CoverageItem,
  type CimPayload,
} from '../server/cim';
import { numeralPostCheck } from '../server/narrative';

describe('fmtCompactUsd', () => {
  it('formats to a clean marketing figure', () => {
    expect(fmtCompactUsd(3200000)).toBe('$3.2M');
    expect(fmtCompactUsd(3000000)).toBe('$3M');
    expect(fmtCompactUsd(850000)).toBe('$850K');
    expect(fmtCompactUsd(500)).toBe('$500');
  });
});

describe('CIM template maps onto the data-room evidence taxonomy', () => {
  const referenced = CIM_SECTIONS.flatMap((s) => s.evidence);

  it('references only real data-room section codes', () => {
    for (const code of referenced) {
      expect(DATA_ROOM_SECTION_CODES).toContain(code);
    }
  });

  it('covers every data-room section exactly once (no gaps, no double-counting)', () => {
    const counts = new Map<string, number>();
    for (const code of referenced) counts.set(code, (counts.get(code) ?? 0) + 1);
    for (const code of DATA_ROOM_SECTION_CODES) {
      expect(counts.get(code), `section ${code} should be mapped exactly once`).toBe(1);
    }
    expect(referenced.length).toBe(DATA_ROOM_SECTION_CODES.length);
  });
});

describe('rollupCimCoverage', () => {
  const item = (
    section_code: string,
    item_code: string,
    readiness_state: CoverageItem['readiness_state'],
    document_status: string | null = null,
  ): CoverageItem => ({ section_code, item_code, label: `${item_code} label`, readiness_state, document_status });

  it('counts ready, verified, and missing per CIM section', () => {
    const cov = rollupCimCoverage([
      // FINANCIAL ← FIN
      item('FIN', 'FIN-1', 'ready', 'verified'),
      item('FIN', 'FIN-2', 'ready'),
      item('FIN', 'FIN-3', 'in_progress'),
      // OPERATIONS ← OPS, HR, CMP
      item('OPS', 'OPS-1', 'ready'),
      item('HR', 'HR-1', 'not_started'),
      item('CMP', 'CMP-1', 'not_applicable'), // out of scope
    ]);
    const fin = cov.sections.find((s) => s.code === 'FINANCIAL')!;
    expect(fin.itemsTotal).toBe(3);
    expect(fin.itemsReady).toBe(2);
    expect(fin.itemsVerified).toBe(1);
    expect(fin.pct).toBe(67); // 2 of 3
    expect(fin.missing.map((m) => m.item_code)).toEqual(['FIN-3']);

    const ops = cov.sections.find((s) => s.code === 'OPERATIONS')!;
    expect(ops.itemsTotal).toBe(2); // OPS-1 + HR-1; CMP-1 is not_applicable
    expect(ops.itemsReady).toBe(1);
    expect(ops.missing.map((m) => m.item_code)).toEqual(['HR-1']);
  });

  it('marks narrative-only sections and excludes them from the evidence summary', () => {
    const cov = rollupCimCoverage([item('FIN', 'FIN-1', 'ready')]);
    const highlights = cov.sections.find((s) => s.code === 'HIGHLIGHTS')!;
    expect(highlights.narrative).toBe(true);
    expect(highlights.itemsTotal).toBe(0);
    // Summary counts only the evidence-backed sections.
    expect(cov.summary.itemsTotal).toBe(1);
    expect(cov.summary.itemsReady).toBe(1);
    expect(cov.summary.pct).toBe(100);
  });
});

describe('composeCim stays inside the numeral firewall', () => {
  const payload: CimPayload = {
    company: {
      name: 'Northwind Fabrication',
      industry: 'Industrial services',
      revenue_band: '$10M-$25M',
      ebitda_band: '$2M-$5M',
      state: 'Ohio',
    },
    highlights: [
      { area: 'Revenue Quality', facts: ['82% of revenue is contractually recurring.'] },
      { area: 'Customer Base', facts: ['Customers stay an average of 7 years.'] },
    ],
    financial: {
      adjusted_ebitda: 3200000,
      reported_ebitda: 2800000,
      adjusted_ebitda_display: '$3.2M',
      reported_ebitda_display: '$2.8M',
    },
    verified_evidence: ['Monthly financial statements (36+ months)', 'EBITDA bridge & add-back schedule'],
    sections: CIM_SECTIONS.map((s) => ({ code: s.code, name: s.name, guidance: s.narrativeGuidance })),
  };

  it('emits no numeral that is absent from the payload', () => {
    const md = composeCim(payload);
    expect(numeralPostCheck(md, payload)).toEqual([]);
  });

  it('leads with the company name and states no asking price', () => {
    const md = composeCim(payload);
    expect(md).toContain('# Confidential Information Memorandum — Northwind Fabrication');
    expect(md.toLowerCase()).toContain('no asking price');
    // Buyer-facing: never the internal readiness vocabulary.
    expect(md.toLowerCase()).not.toContain('gap');
    expect(md.toLowerCase()).not.toContain('weakness');
  });
});

// Both new sell-side documents build FROM the same strengths-only CIM payload, so
// they carry the same firewall guarantees. The teaser adds one more invariant it
// must never break: it is a blind profile, so the company name must not appear.
const sellsidePayload: CimPayload = {
  company: {
    name: 'Northwind Fabrication',
    industry: 'Industrial services',
    revenue_band: '$10M-$25M',
    ebitda_band: '$2M-$5M',
    state: 'Ohio',
  },
  highlights: [
    { area: 'Revenue Quality', facts: ['82% of revenue is contractually recurring.'] },
    { area: 'Customer Base', facts: ['Customers stay an average of 7 years.'] },
  ],
  financial: {
    adjusted_ebitda: 3200000,
    reported_ebitda: 2800000,
    adjusted_ebitda_display: '$3.2M',
    reported_ebitda_display: '$2.8M',
  },
  verified_evidence: ['Monthly financial statements (36+ months)', 'EBITDA bridge & add-back schedule'],
  sections: CIM_SECTIONS.map((s) => ({ code: s.code, name: s.name, guidance: s.narrativeGuidance })),
};

describe('composeTeaser stays inside the numeral firewall and stays anonymous', () => {
  it('emits no numeral that is absent from the payload', () => {
    const md = composeTeaser(sellsidePayload);
    expect(numeralPostCheck(md, sellsidePayload)).toEqual([]);
  });

  it('never names the company (blind profile) and states no asking price', () => {
    const md = composeTeaser(sellsidePayload);
    expect(md).toContain('# Confidential Teaser');
    // A teaser is anonymized — the company name must never leak.
    expect(md).not.toContain('Northwind Fabrication');
    expect(md.toLowerCase()).toContain('no asking price');
    expect(md.toLowerCase()).not.toContain('gap');
    expect(md.toLowerCase()).not.toContain('weakness');
  });
});

describe('composeManagementPresentation stays inside the numeral firewall', () => {
  it('emits no numeral that is absent from the payload', () => {
    const md = composeManagementPresentation(sellsidePayload);
    expect(numeralPostCheck(md, sellsidePayload)).toEqual([]);
  });

  it('names the company (post-NDA) and never surfaces the internal readiness vocabulary', () => {
    const md = composeManagementPresentation(sellsidePayload);
    expect(md).toContain('# Management Presentation — Northwind Fabrication');
    expect(md.toLowerCase()).toContain('no asking price');
    expect(md.toLowerCase()).not.toContain('gap');
    expect(md.toLowerCase()).not.toContain('weakness');
  });
});
