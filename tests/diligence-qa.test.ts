// Diligence Q&A assistant (docs/sellside-ai/05 §4). Proves the two things that
// matter: (1) the RETRIEVAL-ONLY FALLBACK — with no injected generator and AI
// unconfigured, an answer still comes back, deterministically, as the ranked cited
// evidence (mode 'retrieval_only'), which is the exact "no credit in the account"
// degradation; and (2) the AI path — an injected generator's cited answer persists
// as mode 'ai'. Also holds the pure ranking + composer honest without a DB.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { scoreAssessment } from '../server/scoring';
import {
  answerDiligenceQuestion,
  listDiligenceQa,
  composeRetrievalOnly,
  RULE_BASED_MODEL,
} from '../server/diligence-qa';
import { rankPassages, type GroundedPassage } from '../server/intelligence/retrieval';
import { loadFixture, acceptAgreement } from './helpers';

// ── Hermetic: the pure retrieval ranking + the deterministic composer ───────────

describe('rankPassages (pure, keyword overlap)', () => {
  const passages: GroundedPassage[] = [
    { body: 'Customer concentration is high in the top account', cite_id: 'GAP-CONC', citation: 'Assessment gap · critical', source: 'gap' },
    { body: 'Monthly financial statements are reconciled', cite_id: 'DR-FIN', citation: 'Data room · ready', source: 'data_room' },
    { body: 'Revenue recurring mix is document verified', cite_id: 'VF-REV', citation: 'Verified financial input · document', source: 'verified_fact' },
  ];

  it('ranks the passage whose text best overlaps the question first', () => {
    const ranked = rankPassages(passages, 'What is our customer concentration?', 8);
    expect(ranked[0].cite_id).toBe('GAP-CONC');
  });

  it('is deterministic and caps at the limit', () => {
    const a = rankPassages(passages, 'revenue', 2);
    const b = rankPassages(passages, 'revenue', 2);
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
    // The revenue passage wins; zero-overlap passages are retained to fill the limit.
    expect(a[0].cite_id).toBe('VF-REV');
  });

  it('retains zero-overlap passages so a fallback always has evidence', () => {
    const ranked = rankPassages(passages, 'zzz nomatch', 8);
    expect(ranked).toHaveLength(3);
  });
});

describe('composeRetrievalOnly (pure, deterministic fallback)', () => {
  const passages: GroundedPassage[] = [
    { body: 'Customer concentration is high', cite_id: 'GAP-CONC', citation: 'Assessment gap · critical', source: 'gap' },
  ];

  it('labels the unavailability, echoes the question, and cites each passage', () => {
    const md = composeRetrievalOnly('What is our customer concentration?', passages);
    expect(md).toContain('AI synthesis is unavailable');
    expect(md).toContain('What is our customer concentration?');
    expect(md).toContain('[GAP-CONC]');
    expect(md).toContain('Customer concentration is high');
    expect(md).toContain('Assessment gap · critical');
  });

  it('handles no evidence without inventing any', () => {
    const md = composeRetrievalOnly('anything', []);
    expect(md).toContain('No cited source evidence');
  });

  it('is deterministic (same inputs → same text)', () => {
    expect(composeRetrievalOnly('q', passages)).toBe(composeRetrievalOnly('q', passages));
  });
});

// ── DB-guarded: the answer path (fallback + AI) over a migrated, seeded database ─

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('answerDiligenceQuestion (DB)', () => {
  let db: pg.Client;
  let firmId: string;
  let engagementId: string;
  let savedGatewayKey: string | undefined;

  beforeAll(async () => {
    // Force the AI-unconfigured state so the no-generate path degrades to
    // retrieval-only (the fallback under test). Restored in afterAll.
    savedGatewayKey = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;

    db = new pg.Client({ connectionString: url });
    await db.connect();
    const rubricVersionId = (
      await db.query(`select id from rubric_versions where status = 'active' order by created_at desc limit 1`)
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
    firmId = (await db.query(`insert into firms (name) values ('Diligence QA Test Firm') returning id`)).rows[0].id;
    const companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'QA Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await db.query(
        `insert into engagements (firm_id, company_id, started_at) values ($1, $2, '2026-01-01') returning id`,
        [firmId, companyId],
      )
    ).rows[0].id;
    await acceptAgreement(db, engagementId);
    // Fixture 2 scores low across the board, firing gaps + advisory items — so the
    // engagement knowledge source has cited passages to retrieve.
    const assessmentId = (
      await db.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
         values ($1, $2, $3, 1) returning id`,
        [firmId, engagementId, rubricVersionId],
      )
    ).rows[0].id;
    for (const [code, value] of Object.entries(loadFixture('company-2-apex-fabrication').answers)) {
      const qid = questionIds.get(code);
      if (!qid) continue;
      await db.query(`insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`, [
        assessmentId,
        qid,
        JSON.stringify(value),
      ]);
    }
    await scoreAssessment(db, assessmentId);
    await db.query(`update assessments set status = 'completed', completed_at = now() where id = $1`, [
      assessmentId,
    ]);
  });

  afterAll(async () => {
    if (savedGatewayKey !== undefined) process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
    if (!db) return;
    await db.query(`delete from diligence_qa where firm_id = $1`, [firmId]);
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

  it('degrades to retrieval-only with no generator and AI unconfigured (the fallback)', async () => {
    const qa = await answerDiligenceQuestion(
      db,
      firmId,
      engagementId,
      'What is our customer concentration and how reconciled are the financials?',
    );
    expect(qa.mode).toBe('retrieval_only');
    expect(qa.model).toBe(RULE_BASED_MODEL);
    expect(qa.prompt_version).toBe('diligence_qa.v1');
    expect(qa.evidence.length).toBeGreaterThan(0);
    // The answer is the cited source evidence: every evidence cite_id it grounds on
    // appears in the rendered answer.
    expect(qa.answer_md.length).toBeGreaterThan(0);
    for (const ev of qa.evidence) {
      expect(qa.answer_md).toContain(`[${ev.cite_id}]`);
    }
  });

  it('takes the AI path with an injected generator and persists mode ai', async () => {
    const qa = await answerDiligenceQuestion(
      db,
      firmId,
      engagementId,
      'Walk me through revenue quality.',
      // A numeral-free cited answer clears both the numeral firewall and the
      // citation contract regardless of the retrieved figures.
      async () => ({
        text: 'Revenue quality is supported by the cited assessment facts and advisory findings for advisor review.',
        model: 'mock-ai-model',
      }),
    );
    expect(qa.mode).toBe('ai');
    expect(qa.model).toBe('mock-ai-model');
    expect(qa.answer_md).toContain('Revenue quality is supported');

    // It persisted: it comes back from the read path.
    const items = await listDiligenceQa(db, engagementId);
    expect(items.some((i) => i.id === qa.id && i.mode === 'ai')).toBe(true);
  });

  it('lists persisted Q&A newest-first', async () => {
    const items = await listDiligenceQa(db, engagementId);
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].created_at >= items[i].created_at).toBe(true);
    }
    // Both an AI answer and a retrieval-only answer are on record.
    expect(items.some((i) => i.mode === 'ai')).toBe(true);
    expect(items.some((i) => i.mode === 'retrieval_only')).toBe(true);
  });
});
