// Institutional Review seam (docs/20 "AI as an intelligence layer"): the
// narrative-only reviewer that surfaces blind spots / missing evidence / likely
// diligence questions as LABELED DRAFT prose and NEVER grades or computes a score.
//
// DB-free and key-free: the pure assembler/composer are exercised directly, and
// the generation path is driven with an injected fake generator over a fake
// db.query — the same key-free pattern tests/narrative.test.ts uses. The three
// guarantees under test: draft labeling is always present, no invented number
// survives the numeral firewall, and the deterministic fallback works with no key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleReviewPayload,
  composeInstitutionalReview,
  generateInstitutionalReview,
  DRAFT_BANNER,
  type ReviewSources,
} from '../server/institutional-review';
import { numeralPostCheck } from '../server/narrative';
import type { VerificationSummary } from '../server/verification';
import type { AdvisoryFireResult, FiredAdvisoryItem } from '../server/advisory';

// Stub the Anthropic SDK so the "AI configured but the call fails" path (e.g. an
// empty AI-gateway balance) is exercised deterministically, no network. Every
// other test in this file either injects a generator (never touching the SDK) or
// runs key-free, so the stub only bites the fallback test below.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: () =>
        Promise.reject(Object.assign(new Error('insufficient credit'), { status: 402 })),
    };
  },
}));

// --- Fixtures ------------------------------------------------------------------

function advItem(partial: Partial<FiredAdvisoryItem> & Pick<FiredAdvisoryItem, 'item_type' | 'title' | 'body'>): FiredAdvisoryItem {
  return {
    id: partial.id ?? partial.title,
    code: null,
    response_framework: null,
    data_needed: null,
    dimension_code: 'FIN',
    sub_score_code: null,
    severity: 'high',
    buyer_type: null,
    score_trigger: 50,
    source: 'system',
    governing_code: 'FIN',
    governing_score: 40,
    ...partial,
  };
}

const verification: VerificationSummary = {
  verified_inputs: 2,
  total_inputs: 5,
  pct: 40,
  tier: 'partly_verified',
  inputs: [
    { question_id: 'q1', question_code: 'FIN-1', prompt: 'Are monthly statements reconciled?', dimension_code: 'FIN', source: 'self_reported' },
    { question_id: 'q2', question_code: 'FIN-2', prompt: 'Is the revenue recognition policy documented?', dimension_code: 'FIN', source: 'document' },
    { question_id: 'q3', question_code: 'REV-1', prompt: 'Are customer contracts on file?', dimension_code: 'REV', source: 'self_reported' },
    { question_id: 'q4', question_code: 'REV-2', prompt: 'Is churn tracked in the ledger?', dimension_code: 'REV', source: 'connected_ledger' },
    { question_id: 'q5', question_code: 'FIN-3', prompt: 'Are add-backs supported by invoices?', dimension_code: 'FIN', source: 'self_reported' },
  ],
};

const advisory: AdvisoryFireResult = {
  assessment_id: 'a1',
  items: [
    advItem({ item_type: 'buyer_question', title: 'Customer concentration', body: 'How exposed is the business if the top account leaves?', severity: 'high', buyer_type: 'strategic' }),
    advItem({ item_type: 'risk_flag', title: 'Owner dependence', body: 'The business depends on the owner for key relationships.', severity: 'critical' }),
    advItem({ item_type: 'initiative', title: 'Build a management layer', body: 'A remediation initiative, not a buyer question.' }),
  ],
  counts: { buyer_question: 1, initiative: 1, risk_flag: 1, critical: 1, high: 1 },
};

const sources: ReviewSources = {
  company: { name: 'Cascade Facility Services', industry: 'Facilities' },
  engagement_target_window: '24-36 months',
  overall_score: 61.5,
  band: 'Needs Work',
  owner_readiness_index: 55,
  dimensions: [
    { name: 'Financial Integrity', score: 48 },
    { name: 'Revenue Quality', score: 72 },
  ],
  flagged_gaps: [
    { name: 'Owner Dependence', severity: 'critical' },
    { name: 'Reconciliation Discipline Gap', severity: 'med' },
  ],
  flags: ['NRR not tracked'],
  verification,
  advisory,
};

// --- Pure assembler ------------------------------------------------------------

describe('assembleReviewPayload (pure)', () => {
  it('reduces verification to its evidence-gap view (only self-reported inputs)', () => {
    const p = assembleReviewPayload(sources);
    expect(p.evidence_gaps.verified_inputs).toBe(2);
    expect(p.evidence_gaps.total_inputs).toBe(5);
    expect(p.evidence_gaps.pct).toBe(40);
    expect(p.evidence_gaps.unverified).toEqual([
      'Are monthly statements reconciled?',
      'Are customer contracts on file?',
      'Are add-backs supported by invoices?',
    ]);
  });

  it('keeps only buyer questions and risk flags as diligence questions (never initiatives)', () => {
    const p = assembleReviewPayload(sources);
    expect(p.likely_diligence_questions.map((q) => q.title)).toEqual([
      'Customer concentration',
      'Owner dependence',
    ]);
    expect(p.likely_diligence_questions.every((q) => q.concern.length > 0)).toBe(true);
  });

  it('carries scores through verbatim and derives no new number', () => {
    const p = assembleReviewPayload(sources);
    expect(p.overall_score).toBe(61.5);
    expect(p.band).toBe('Needs Work');
    expect(p.owner_readiness_index).toBe(55);
    // every numeral in the assembled payload traces to a source numeral
    expect(numeralPostCheck(JSON.stringify(p), sources)).toEqual([]);
  });
});

// --- Deterministic composer ----------------------------------------------------

describe('composeInstitutionalReview (pure, firewall-clean)', () => {
  const payload = assembleReviewPayload(sources);

  it('labels the review as draft and never claims to grade', () => {
    const md = composeInstitutionalReview(payload);
    expect(md).toContain('# Institutional Review — Cascade Facility Services');
    expect(md).toContain(DRAFT_BANNER);
    expect(md.toLowerCase()).toContain('does not compute, adjust, or grade any score');
  });

  it('renders the three reviewer lenses from the payload', () => {
    const md = composeInstitutionalReview(payload);
    expect(md).toContain('## Blind spots a buyer will probe');
    expect(md).toContain('## Missing evidence');
    expect(md).toContain('## Likely diligence questions');
    expect(md).toContain('Owner Dependence');
    expect(md).toContain('Are monthly statements reconciled?'); // unverified evidence
    expect(md).toContain('Customer concentration'); // fired buyer question
    expect(md).toContain('NRR not tracked'); // untracked flag as a blind spot
  });

  it('emits no numeral absent from the payload (numeral firewall clean)', () => {
    const md = composeInstitutionalReview(payload);
    expect(numeralPostCheck(md, payload)).toEqual([]);
  });

  it('is deterministic (same payload → same review)', () => {
    expect(composeInstitutionalReview(payload)).toBe(composeInstitutionalReview(payload));
  });
});

// --- Generation path over a fake db + injected fake generator -------------------
// The fake db answers exactly the reads buildInstitutionalReviewPayload issues
// (header, dimensions, gaps) plus the descriptive verification/advisory rollups it
// reuses. No real database, no API key.

function fakeDb() {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return {
    query: vi.fn(async (sql: string) => {
      const q = norm(sql);
      // buildInstitutionalReviewPayload — header
      if (q.includes('from active_assessments a')) {
        return {
          rows: [
            {
              id: 'a1',
              engagement_id: 'e1',
              drs_score: 61.5,
              drs_tier: 'Needs Work',
              ori_score: 55,
              target_exit_window: '24-36 months',
              company_name: 'Cascade Facility Services',
              industry: 'Facilities',
            },
          ],
          rowCount: 1,
        };
      }
      // buildInstitutionalReviewPayload — dimensions (distinguished by the sort)
      if (q.includes('from dimension_scores ds') && q.includes('order by d.sort_order')) {
        return {
          rows: [
            { name: 'Financial Integrity', score: 48 },
            { name: 'Revenue Quality', score: 72 },
          ],
          rowCount: 2,
        };
      }
      // buildInstitutionalReviewPayload — flagged gaps
      if (q.includes('from gaps g')) {
        return { rows: [{ name: 'Owner Dependence', severity: 'critical' }], rowCount: 1 };
      }
      // verificationSummary — rubric version lookup
      if (q.includes('select rubric_version_id from assessments')) {
        return { rows: [{ rubric_version_id: 'rv1' }], rowCount: 1 };
      }
      // verificationSummary — financial inputs (none in scope here)
      if (q.includes('from questions q') && q.includes('answer_provenance')) {
        return { rows: [], rowCount: 0 };
      }
      // fireAdvisoryItems — engagement lookup
      if (q.includes('select id, firm_id from engagements')) {
        return { rows: [{ id: 'e1', firm_id: 'f1' }], rowCount: 1 };
      }
      // fireAdvisoryItems — latest completed assessment
      if (q.includes('from assessments') && q.includes("status = 'completed'")) {
        return { rows: [{ id: 'a1' }], rowCount: 1 };
      }
      // fireAdvisoryItems — persisted dimension scores (no sort → not the review query)
      if (q.includes('select d.code, ds.score from dimension_scores ds')) {
        return { rows: [], rowCount: 0 };
      }
      // fireAdvisoryItems — persisted sub-score results
      if (q.includes('from sub_score_results ssr')) {
        return { rows: [], rowCount: 0 };
      }
      // fireAdvisoryItems — advisory catalog
      if (q.includes('from advisory_library_items')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`fake db: unhandled query: ${q}`);
    }),
  };
}

describe('generateInstitutionalReview (fake db + injected generator)', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
  });

  it('stamps the draft label even when the model omits it, with prompt_version and model', async () => {
    const db = fakeDb() as never;
    const review = await generateInstitutionalReview(db, 'a1', async () => ({
      // The model cites only a payload number (61.5) and omits any banner.
      text: '## Blind spots a buyer will probe\n\nDiligence readiness sits at 61.5.',
      model: 'mock-model',
    }));
    expect(review.is_draft).toBe(true);
    expect(review.doc_type).toBe('institutional_review');
    expect(review.prompt_version).toBe('institutional_review.v1');
    expect(review.model).toBe('mock-model');
    expect(review.content_md.startsWith(DRAFT_BANNER)).toBe(true); // label guaranteed
  });

  it('regenerates once on an invented number, then fails loudly', async () => {
    const db = fakeDb() as never;
    let calls = 0;
    await expect(
      generateInstitutionalReview(db, 'a1', async () => {
        calls++;
        return { text: 'A buyer would value this near 5000000 dollars.', model: 'mock-model' };
      }),
    ).rejects.toThrow(/numerals not present in the input payload/);
    expect(calls).toBe(2);

    // A generator that fixes itself on the retry succeeds.
    let attempt = 0;
    const review = await generateInstitutionalReview(db, 'a1', async () => {
      attempt++;
      return attempt === 1
        ? { text: 'Concentration risk implies a 3.5x haircut.', model: 'mock-model' }
        : { text: 'Diligence will probe the flagged blind spots.', model: 'mock-model' };
    });
    expect(attempt).toBe(2);
    expect(review.content_md).toContain('flagged blind spots');
    expect(numeralPostCheck(review.content_md, review.payload)).toEqual([]);
  });

  it('falls back to the composer when the AI call fails (empty gateway balance)', async () => {
    // AI is configured (gateway key present) but the balance is empty, so the
    // stubbed SDK rejects with a 402. The review must still generate, seamlessly,
    // from the deterministic composer — labeled rule-based, not an error.
    process.env.AI_GATEWAY_API_KEY = 'vk-test-empty-balance';
    const db = fakeDb() as never;
    const review = await generateInstitutionalReview(db, 'a1'); // no generator → auto path → 402 → fallback
    expect(review.model).toMatch(/^rule-based/);
    expect(review.is_draft).toBe(true);
    expect(review.content_md).toContain('# Institutional Review — Cascade Facility Services');
    expect(review.content_md).toContain(DRAFT_BANNER);
    expect(numeralPostCheck(review.content_md, review.payload)).toEqual([]);
  });

  it('falls back to the deterministic composer with no key and no generator', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    const db = fakeDb() as never;
    const review = await generateInstitutionalReview(db, 'a1');
    expect(review.model).toMatch(/^rule-based/);
    expect(review.is_draft).toBe(true);
    expect(review.content_md).toContain('# Institutional Review — Cascade Facility Services');
    expect(review.content_md).toContain(DRAFT_BANNER);
    expect(review.content_md).toContain('Owner Dependence'); // fired gap from the fake db
    // the composer's own output never trips the numeral firewall
    expect(numeralPostCheck(review.content_md, review.payload)).toEqual([]);
  });
});
