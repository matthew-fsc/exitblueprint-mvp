// Server-layer round trip for the ExitBlueprint Bench store (docs/sellside-ai/02,
// docs/09). Requires a migrated + seeded database (DATABASE_URL); skipped otherwise.
// Proves that recordBenchRun grades the deliverables and persists a run into the
// service-role-only analytics schema, that benchSummary reads the latest run back in
// the agreed dashboard shape, and that an empty store degrades to { last_run_at: null,
// results: [] } — the platform-quality rail (NOT cross-firm client data).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { recordBenchRun, benchSummary } from '../server/bench-metrics';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('ExitBlueprint Bench store (server, DB-backed)', () => {
  let db: pg.Client;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    // Start from an empty store — only this feature ever writes these tables, so
    // clearing the run header (cascade) resets both runs and results.
    await db.query(`delete from analytics.bench_runs`);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from analytics.bench_runs`);
    await db.end();
  });

  it('returns an empty summary when the store has no runs', async () => {
    const summary = await benchSummary(db);
    expect(summary).toEqual({ last_run_at: null, results: [] });
  });

  it('records a run and reads it back in the agreed dashboard shape', async () => {
    const run = await recordBenchRun(db);
    // The static tier always runs (pure checks over disk fixtures), so at least one
    // case is graded regardless of whether a completed assessment was present.
    expect(run.inserted).toBeGreaterThanOrEqual(1);
    expect(typeof run.run_at).toBe('string');

    const summary = await benchSummary(db);
    expect(summary.last_run_at).not.toBeNull();
    expect(summary.results.length).toBe(run.inserted);

    for (const r of summary.results) {
      expect(typeof r.doc_type).toBe('string');
      expect(r.doc_type.length).toBeGreaterThan(0);
      expect(typeof r.prompt_version).toBe('string');
      expect(r.prompt_version.length).toBeGreaterThan(0);
      expect(typeof r.model).toBe('string');
      expect(typeof r.case_name).toBe('string');
      expect(['static', 'generated']).toContain(r.tier);
      expect(typeof r.answer_score).toBe('number');
      expect(typeof r.source_score).toBe('number');
      expect(r.answer_score).toBeGreaterThanOrEqual(0);
      expect(r.answer_score).toBeLessThanOrEqual(1);
      expect(r.source_score).toBeGreaterThanOrEqual(0);
      expect(r.source_score).toBeLessThanOrEqual(1);
      expect(typeof r.run_at).toBe('string');
    }

    // The static tier is always present; every row in a single run shares the run_at.
    expect(summary.results.some((r) => r.tier === 'static')).toBe(true);
    expect(summary.results.every((r) => r.run_at === summary.last_run_at)).toBe(true);
  });
});
