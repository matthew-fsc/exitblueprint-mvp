// Hermetic tests for answer extraction (docs/sellside-ai WS-EXTRACT). No live DB
// and no network: a fake pg client serves canned reads and captures writes, and a
// fake LLM transport returns the model's "structured output". These prove the
// three invariants that matter:
//   1. text → validated candidate rows (the AI proposes; rows land in the STAGING
//      table answer_candidates, never in `answers`);
//   2. a malformed / prose model response is REJECTED by the strict schema, so
//      nothing is staged;
//   3. confirm promotes a candidate through the EXISTING answer-writing path
//      (`insert into answers … on conflict …` + answer_provenance) and marks the
//      candidate confirmed — the human gate that keeps scoring deterministic.
import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import {
  extractAnswerCandidates,
  confirmAnswerCandidate,
  parseAnswerCandidates,
} from '../server/answer-extraction';
import { LlmClient, type LlmTransport } from '../server/llm/client';
import { answerCandidatesOutputSchema } from '../shared/intelligence/schemas';

interface Write {
  sql: string;
  params: unknown[];
}

// A route-matching fake pg client: reads return canned rows keyed by an SQL
// substring; every insert/update is captured for assertion. Anything unmatched
// returns an empty result (so incidental queries never throw).
function fakeDb(routes: Array<[string, Record<string, unknown>[]]>): {
  db: pg.ClientBase;
  writes: Write[];
} {
  const writes: Write[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      const trimmed = sql.trim();
      if (/^(insert|update)/i.test(trimmed)) {
        writes.push({ sql: trimmed, params });
      }
      for (const [needle, rows] of routes) {
        if (sql.includes(needle)) return { rows, rowCount: rows.length } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
  } as unknown as pg.ClientBase;
  return { db, writes };
}

const transportReturning = (text: string): LlmTransport => async (req) => ({
  text,
  model: req.model,
  usage: { input_tokens: 5, output_tokens: 5 },
});

describe('parseAnswerCandidates (schema gate)', () => {
  const allowed = new Set(['REV-ANNUAL', 'REV-RECUR-PCT']);

  it('accepts well-formed candidates for known questions', () => {
    const out = parseAnswerCandidates(
      JSON.stringify({
        candidates: [{ question_code: 'REV-ANNUAL', value: [100, 200], confidence: 0.8, source_span: 'row 3' }],
      }),
      allowed,
    );
    expect(out).toHaveLength(1);
    expect(out[0].question_code).toBe('REV-ANNUAL');
  });

  it('rejects non-JSON (prose) output', () => {
    expect(() => parseAnswerCandidates('Here are the answers: revenue is up.', allowed)).toThrow();
  });

  it('rejects output that does not match the schema (out-of-range confidence)', () => {
    expect(() =>
      parseAnswerCandidates(
        JSON.stringify({ candidates: [{ question_code: 'REV-ANNUAL', value: 1, confidence: 1.5 }] }),
        allowed,
      ),
    ).toThrow();
    // Direct schema assertion too — the contract, not just the wrapper.
    expect(() =>
      answerCandidatesOutputSchema.parse({ candidates: [{ question_code: 'x', value: 1, confidence: 2 }] }),
    ).toThrow();
  });

  it('drops candidates for questions not in the rubric (defense in depth)', () => {
    const out = parseAnswerCandidates(
      JSON.stringify({
        candidates: [
          { question_code: 'REV-ANNUAL', value: 1, confidence: 0.9 },
          { question_code: 'NOT-A-QUESTION', value: 2, confidence: 0.9 },
        ],
      }),
      allowed,
    );
    expect(out.map((c) => c.question_code)).toEqual(['REV-ANNUAL']);
  });
});

describe('extractAnswerCandidates', () => {
  const baseRoutes = (): Array<[string, Record<string, unknown>[]]> => [
    ['from assessments', [{ id: 'a1', rubric_version_id: 'r1' }]],
    ['from documents where id', [{ id: 'doc1' }]],
    [
      'from questions q',
      [
        { code: 'REV-ANNUAL', prompt: 'Annual revenue', answer_type: 'numeric' },
        { code: 'REV-RECUR-PCT', prompt: 'Recurring %', answer_type: 'numeric' },
      ],
    ],
    ['insert into answer_candidates', [{ id: 'c1', created_at: new Date('2026-07-24T00:00:00Z') }]],
  ];

  it('maps document text → staged candidate rows via a fake transport', async () => {
    const { db, writes } = fakeDb(baseRoutes());
    const llm = new LlmClient({
      transport: transportReturning(
        JSON.stringify({
          candidates: [
            { question_code: 'REV-ANNUAL', value: [900000, 1100000], confidence: 0.72, source_span: 'Total Income' },
          ],
        }),
      ),
    });

    const res = await extractAnswerCandidates(db, {
      firmId: 'f1',
      engagementId: 'e1',
      documentId: 'doc1',
      llm,
      readText: async () => 'Total Income,900000,1100000',
    });

    expect(res.proposed).toBe(1);
    expect(res.candidates[0].question_code).toBe('REV-ANNUAL');
    expect(res.candidates[0].status).toBe('pending');

    // The ONLY write is to the STAGING table — never to `answers` (rule 2).
    const inserts = writes.filter((w) => /^insert/i.test(w.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain('insert into answer_candidates');
    expect(writes.some((w) => /insert into answers/i.test(w.sql))).toBe(false);
  });

  it('rejects a prose (non-JSON) model response and stages nothing', async () => {
    const { db, writes } = fakeDb(baseRoutes());
    const llm = new LlmClient({ transport: transportReturning('Revenue looks like about $1M.') });

    await expect(
      extractAnswerCandidates(db, {
        firmId: 'f1',
        engagementId: 'e1',
        documentId: 'doc1',
        llm,
        readText: async () => 'anything',
      }),
    ).rejects.toThrow();
    expect(writes.some((w) => w.sql.includes('insert into answer_candidates'))).toBe(false);
  });

  it('errors when the engagement has no in-progress assessment', async () => {
    const { db } = fakeDb([['from documents where id', [{ id: 'doc1' }]]]); // assessments route absent → []
    const llm = new LlmClient({ transport: transportReturning('{"candidates":[]}') });
    await expect(
      extractAnswerCandidates(db, {
        firmId: 'f1',
        engagementId: 'e1',
        documentId: 'doc1',
        llm,
        readText: async () => 'x',
      }),
    ).rejects.toThrow(/no in-progress assessment/);
  });
});

describe('confirmAnswerCandidate (promote through the deterministic path)', () => {
  const confirmRoutes = (
    status = 'pending',
    assessmentStatus = 'in_progress',
  ): Array<[string, Record<string, unknown>[]]> => [
    [
      'from answer_candidates where id',
      [
        {
          id: 'c1',
          firm_id: 'f1',
          engagement_id: 'e1',
          assessment_id: 'a1',
          question_code: 'REV-ANNUAL',
          candidate_value: [900000, 1100000],
          source_document_id: 'doc1',
          status,
        },
      ],
    ],
    ['from assessments where id', [{ id: 'a1', firm_id: 'f1', rubric_version_id: 'r1', status: assessmentStatus }]],
    ['from questions q join dimensions', [{ id: 'q1' }]],
    ['from documents where id', [{ id: 'doc1' }]],
  ];

  it('writes the answer + document provenance and marks the candidate confirmed', async () => {
    const { db, writes } = fakeDb(confirmRoutes());
    const res = await confirmAnswerCandidate(db, 'c1', 'prof1');

    expect(res.status).toBe('confirmed');
    expect(res.source).toBe('document'); // source doc resolved for the firm → verified

    // Promoted through the EXISTING answer-writing path.
    const answerWrite = writes.find((w) => /insert into answers/i.test(w.sql));
    expect(answerWrite).toBeDefined();
    expect(answerWrite!.sql).toContain('on conflict (assessment_id, question_id)');
    expect(answerWrite!.params).toEqual(['a1', 'q1', JSON.stringify([900000, 1100000])]);

    expect(writes.some((w) => /insert into answer_provenance\b/i.test(w.sql))).toBe(true);

    const statusUpdate = writes.find((w) => /update answer_candidates set status = 'confirmed'/i.test(w.sql));
    expect(statusUpdate).toBeDefined();
  });

  it('refuses to write into a completed (immutable) assessment', async () => {
    const { db, writes } = fakeDb(confirmRoutes('pending', 'completed'));
    await expect(confirmAnswerCandidate(db, 'c1', 'prof1')).rejects.toThrow(/immutable/);
    expect(writes.some((w) => /insert into answers/i.test(w.sql))).toBe(false);
  });

  it('refuses to re-confirm an already-disposed candidate', async () => {
    const { db, writes } = fakeDb(confirmRoutes('confirmed'));
    await expect(confirmAnswerCandidate(db, 'c1', 'prof1')).rejects.toThrow(/already confirmed/);
    expect(writes.some((w) => /insert into answers/i.test(w.sql))).toBe(false);
  });
});
