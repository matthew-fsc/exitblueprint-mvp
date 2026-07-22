// S8 narrative service: numeral post-check (pure) and generateDocument against
// the database with an injected mock generator (no API key needed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  buildOwnerReportPayload,
  composeDeltaReport,
  composeOwnerReport,
  generateDocument,
  numeralPostCheck,
  type DeltaReportPayload,
} from '../server/narrative';
import { explainAssessment, scoreAssessment } from '../server/scoring';
import { interpretSubScore, qualityBand } from '../shared/scoring/interpret';
import type { Answers } from '../shared/scoring/types';
import { loadFixture, acceptAgreement } from './helpers';

describe('numeralPostCheck', () => {
  const payload = { score: 61.5, dims: [{ name: 'Revenue', score: 72.25 }], count: 3 };

  it('accepts output whose numerals all come from the payload', () => {
    expect(
      numeralPostCheck('Your score of 61.5 reflects Revenue at 72.25 across 3 areas.', payload),
    ).toEqual([]);
  });

  it('rejects invented numerals, including derived arithmetic', () => {
    // 10.75 is a delta the model computed itself — exactly what the rule forbids
    expect(numeralPostCheck('Revenue (72.25) exceeds your score by 10.75 points.', payload)).toEqual(
      ['10.75'],
    );
  });

  it('whitelists years and markdown list numbering', () => {
    const output = '1. First priority\n2. Second priority\nSince 2024, buyers expect this.';
    expect(numeralPostCheck(output, payload)).toEqual([]);
  });

  it('does not whitelist non-list-position numbers on numbered lines', () => {
    expect(numeralPostCheck('1. Improve retention by 15 percent', payload)).toEqual(['15']);
  });
});

// Deterministic delta composer (F4) — pure, no DB. Every figure must trace to
// the payload, so the numeral firewall passes on its own output.
describe('composeDeltaReport', () => {
  const deltaPayload: DeltaReportPayload = {
    mode: 'delta',
    company: { name: 'Cascade Facility Services', industry: 'Facilities' },
    engagement_target_window: '24-36 months',
    current: { drs: 72.3, tier: 'Sale Ready', ori: 63.2, date: '2026-07-06' },
    prior: { drs: 59.9, tier: 'Needs Work', ori: 55, date: '2025-10-06' },
    drs_delta: 12.4,
    ori_delta: 8.2,
    dimensions: [
      { name: 'Revenue Quality', current: 82.31, prior: 73.31, delta: 9 },
      { name: 'Financial Integrity', current: 76, prior: 56.5, delta: 19.5 },
    ],
    gaps_resolved: ['Owner Dependence', 'Reconciliation Discipline Gap'],
    gaps_opened: [],
    open_gaps: ['Incomplete Financial Statements', 'GAAP Proximity Gap'],
    counts: { gaps_resolved: 2, gaps_opened: 0, open_gaps: 2 },
  };

  it('composes a delta report using only payload figures (firewall-clean)', () => {
    const md = composeDeltaReport(deltaPayload);
    expect(md).toContain('# Progress this period — Cascade Facility Services');
    expect(md).toContain('59.9 to 72.3');
    expect(md).toContain('up 12.4 points');
    // no invented numerals: the composer's own output passes the numeral firewall
    expect(numeralPostCheck(md, deltaPayload)).toEqual([]);
  });

  it('renders baseline mode with levels, never a fabricated change', () => {
    const baseline: DeltaReportPayload = {
      ...deltaPayload,
      mode: 'baseline',
      prior: null,
      drs_delta: null,
      ori_delta: null,
      gaps_resolved: [],
      dimensions: deltaPayload.dimensions.map((d) => ({ ...d, prior: null, delta: null })),
    };
    const md = composeDeltaReport(baseline);
    expect(md).toContain('# Baseline readiness — Cascade Facility Services');
    expect(md).not.toMatch(/points/); // no movement language in baseline
    expect(numeralPostCheck(md, baseline)).toEqual([]);
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('generateDocument', () => {
  let db: pg.Client;
  let firmId: string;
  let assessmentId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const rubricVersionId = (
      await db.query(`select id from rubric_versions where status = 'active' order by created_at desc limit 1`)
    ).rows[0].id;
    firmId = (
      await db.query(`insert into firms (name) values ('Narrative Test Firm') returning id`)
    ).rows[0].id;
    const companyId = (
      await db.query(
        `insert into companies (firm_id, name, industry) values ($1, 'Narrative Test Co', 'Staffing') returning id`,
        [firmId],
      )
    ).rows[0].id;
    const engagementId = (
      await db.query(
        `insert into engagements (firm_id, company_id, target_exit_window) values ($1, $2, '24-36 months') returning id`,
        [firmId, companyId],
      )
    ).rows[0].id;
    await acceptAgreement(db, engagementId);
    assessmentId = (
      await db.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
         values ($1, $2, $3, 1) returning id`,
        [firmId, engagementId, rubricVersionId],
      )
    ).rows[0].id;
    const questionIds = new Map<string, string>(
      (
        await db.query(
          `select q.id, q.code from questions q join dimensions d on d.id = q.dimension_id
           where d.rubric_version_id = $1`,
          [rubricVersionId],
        )
      ).rows.map((r) => [r.code, r.id]),
    );
    const answers: Answers = loadFixture('company-3-harborview-staffing').answers;
    for (const [code, value] of Object.entries(answers)) {
      const questionId = questionIds.get(code);
      if (!questionId) continue;
      await db.query(`insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`, [
        assessmentId,
        questionId,
        JSON.stringify(value),
      ]);
    }
    await scoreAssessment(db, assessmentId);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from generated_documents where firm_id = $1`, [firmId]);
    for (const table of ['sub_score_results', 'dimension_scores', 'answers']) {
      await db.query(
        `delete from ${table} where assessment_id in (select id from assessments where firm_id = $1)`,
        [firmId],
      );
    }
    await db.query(`delete from gaps where firm_id = $1`, [firmId]);
    await db.query(`delete from assessments where firm_id = $1`, [firmId]);
    await db.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('builds a payload with only server-computed figures', async () => {
    const fixture = loadFixture('company-3-harborview-staffing');
    const payload = await buildOwnerReportPayload(db, assessmentId);
    expect(payload.company.name).toBe('Narrative Test Co');
    expect(payload.overall_score).toBe(fixture.expected.drs);
    expect(payload.band).toBe(fixture.expected.tier);
    expect(payload.top_gaps.length).toBeLessThanOrEqual(5);
    expect(payload.top_gaps[0].severity).toBe('critical'); // sorted by severity
    expect(payload.top_gaps.every((g) => g.playbook)).toBe(true);
    expect(payload.prior_comparison).toBeNull(); // baseline assessment
  });

  it('stores a draft with prompt_version and model when the output passes the check', async () => {
    const doc = await generateDocument(db, assessmentId, 'owner_report', async () => ({
      text: `# Exit Readiness Report — Narrative Test Co\n\nYour overall score is ${loadFixture('company-3-harborview-staffing').expected.drs}.`,
      model: 'mock-model',
    }));
    expect(doc.prompt_version).toBe('owner_report.v1');
    expect(doc.model).toBe('mock-model');
    expect(doc.finalized_at).toBeNull();
    expect(doc.content_md).toContain('Exit Readiness Report');
  });

  it('regenerates once on a numeral violation, then fails loudly', async () => {
    let calls = 0;
    // Mock that always invents a number → regenerate once → loud failure
    await expect(
      generateDocument(db, assessmentId, 'owner_report', async () => {
        calls++;
        return { text: 'Your business could be worth 5000000 dollars.', model: 'mock-model' };
      }),
    ).rejects.toThrow(/numerals not present in the input payload/);
    expect(calls).toBe(2);

    // Mock that fixes itself on the retry succeeds
    let attempt = 0;
    const doc = await generateDocument(db, assessmentId, 'owner_report', async () => {
      attempt++;
      return attempt === 1
        ? { text: 'A 3.5x multiple is realistic.', model: 'mock-model' }
        : { text: 'Buyers will focus on your flagged gaps.', model: 'mock-model' };
    });
    expect(attempt).toBe(2);
    expect(doc.content_md).toContain('flagged gaps');
  });

  it('rejects doc types that are not implemented yet', async () => {
    await expect(generateDocument(db, assessmentId, 'advisor_brief')).rejects.toThrow(
      /not implemented yet/,
    );
  });

  it('generates a rule-based report with NO API key and no injected generator', async () => {
    delete process.env.ANTHROPIC_API_KEY; // ensure the deterministic path
    const doc = await generateDocument(db, assessmentId, 'owner_report');
    expect(doc.model).toMatch(/^rule-based/);
    // premise intact: score, tier, and the fixture's flagged gaps are all present
    const fixture = loadFixture('company-3-harborview-staffing');
    expect(doc.content_md).toContain('Narrative Test Co');
    expect(doc.content_md).toContain(String(fixture.expected.drs));
    expect(doc.content_md).toContain(fixture.expected.tier);
    expect(doc.content_md).toContain('## What to fix first');
    // reads like prose, not code — no formula names or field keys leak in
    expect(doc.content_md).not.toMatch(/sub_score_below|formulaType|hhi_est/);
  });

  it('composeOwnerReport is deterministic (same inputs → same report)', async () => {
    const payload = await buildOwnerReportPayload(db, assessmentId);
    const explain = await explainAssessment(db, assessmentId);
    expect(composeOwnerReport(payload, explain)).toBe(composeOwnerReport(payload, explain));
  });

  it('generates the sell-side teaser and management presentation (rule-based path)', async () => {
    delete process.env.ANTHROPIC_API_KEY; // deterministic composers

    const teaser = await generateDocument(db, assessmentId, 'teaser');
    expect(teaser.doc_type).toBe('teaser');
    expect(teaser.model).toBe('rule-based:teaser.v1');
    expect(teaser.prompt_version).toBe('teaser.v1');
    expect(teaser.content_md).toContain('# Confidential Teaser');
    // A teaser is a blind profile — the company name must never appear.
    expect(teaser.content_md).not.toContain('Narrative Test Co');

    const mgmt = await generateDocument(db, assessmentId, 'management_presentation');
    expect(mgmt.doc_type).toBe('management_presentation');
    expect(mgmt.model).toBe('rule-based:management_presentation.v1');
    expect(mgmt.prompt_version).toBe('management_presentation.v1');
    // Post-NDA meeting material — it names the company.
    expect(mgmt.content_md).toContain('# Management Presentation — Narrative Test Co');
  });
});

describe('interpret layer (pure, plain-language)', () => {
  it('bands points into readable labels', () => {
    expect(qualityBand(90).label).toBe('Strong');
    expect(qualityBand(60).label).toBe('Adequate');
    expect(qualityBand(30).label).toBe('Needs work');
    expect(qualityBand(10).label).toBe('At risk');
  });

  it('renders a recurring-revenue sub-score as a plain sentence, no code', () => {
    const r = interpretSubScore({
      code: 'REV-RECUR',
      name: 'Recurring Revenue Percentage',
      dimensionCode: 'REV',
      formulaType: 'band_gte',
      inputs: { 'REV-RECUR-PCT': 45 },
      computed: { value: 45 },
      points: 50,
      weight: 0.3,
      contribution: 15,
    });
    expect(r.reading).toBe('45% of revenue is contractually recurring.');
    expect(r.band.label).toBe('Adequate');
    expect(r.measures).toMatch(/renews on its own/);
    expect(r.benchmark).toMatch(/80%/);
    expect(JSON.stringify(r)).not.toMatch(/band_gte/);
  });
});
