// Market-context retrieval (docs/sellside-ai/01-market-intelligence-rag.md, build
// order step 2). Two layers:
//   1. HERMETIC (no DB): parseMarketPassages parses the shipped seed/market-passages.csv
//      to the expected shape — non-empty body/cite_id/citation, industry_key in the
//      valuation key-space, every kind labelled.
//   2. DB-backed (guarded on DATABASE_URL, skipped without it): retrieveMarketContext
//      returns a seeded passage, and a STRICTER exposure filters an aggregate_only
//      dataset out (the license-exposure enforcement that stands in for RLS on the
//      non-tenant market schema).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadSeedBundle, parseMarketPassages, resolveSeedDir } from '../server/seed-methodology';
import { retrieveMarketContext } from '../server/market-retrieval';

const seedDir = resolveSeedDir();
const csv = readFileSync(join(seedDir, 'market-passages.csv'), 'utf8');
const passages = parseMarketPassages(csv);

// The valuation-multiples set is authoritative for the industry_key space; every
// passage must be keyed within it so a passage lines up with its sector's multiple.
const bundle = loadSeedBundle(seedDir);
const validIndustries = new Set(bundle.valuationMultiples.map((m) => m.industryKey));

describe('parseMarketPassages (hermetic)', () => {
  it('parses at least one passage per industry_key (sector_commentary + precedent)', () => {
    expect(passages.length).toBeGreaterThan(0);
    for (const key of validIndustries) {
      const forKey = passages.filter((p) => p.industryKey === key);
      expect(forKey.length).toBeGreaterThanOrEqual(2);
      expect(forKey.some((p) => p.kind === 'sector_commentary')).toBe(true);
      expect(forKey.some((p) => p.kind === 'precedent_transaction')).toBe(true);
    }
  });

  it('every row has the required cited shape', () => {
    for (const p of passages) {
      expect(validIndustries.has(p.industryKey)).toBe(true);
      expect(p.body.trim().length).toBeGreaterThan(0);
      expect(p.citeId.trim().length).toBeGreaterThan(0);
      expect(p.citation.trim().length).toBeGreaterThan(0);
      expect(p.kind.trim().length).toBeGreaterThan(0);
      // size_band is optional; when present it is a non-empty string.
      if (p.sizeBand !== null) expect(p.sizeBand.trim().length).toBeGreaterThan(0);
      // as_of, when present, parses as a date.
      if (p.asOf !== null) expect(Number.isNaN(Date.parse(p.asOf))).toBe(false);
    }
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('retrieveMarketContext (DB-backed)', () => {
  let db: pg.Client;
  const datasetIds: string[] = [];
  const industryKey = 'field_services';
  const sizeBand = '3_5m';

  const makeDataset = async (name: string, scope: string) => {
    const id = (
      await db.query(
        `insert into market.datasets
           (name, vendor, display_scope, ai_ingestion_allowed, derivative_rights,
            purge_on_termination, as_of)
         values ($1, 'test-vendor', $2, false, false, true, current_date)
         returning id`,
        [name, scope],
      )
    ).rows[0].id as string;
    datasetIds.push(id);
    return id;
  };

  const addPassage = async (datasetId: string, citeId: string, body: string) =>
    db.query(
      `insert into market.passages
         (dataset_id, industry_key, size_band, kind, body, cite_id, citation, as_of)
       values ($1, $2, $3, 'sector_commentary', $4, $5, 'Test citation', current_date)`,
      [datasetId, industryKey, sizeBand, body, citeId],
    );

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const aggId = await makeDataset('MR Test aggregate_only', 'aggregate_only');
    await addPassage(aggId, 'MRT-AGG-01', 'Placeholder aggregate-only market passage for retrieval test.');
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of datasetIds) {
      await db.query(`delete from market.passages where dataset_id = $1`, [id]);
      await db.query(`delete from market.datasets where id = $1`, [id]);
    }
    await db.end();
  });

  it('returns a matching aggregate_only passage under the default exposure', async () => {
    const { passages: got } = await retrieveMarketContext(db, { industryKey, sizeBand });
    const mine = got.filter((p) => p.cite_id === 'MRT-AGG-01');
    expect(mine.length).toBe(1);
    expect(mine[0].citation).toBe('Test citation');
    expect(mine[0].kind).toBe('sector_commentary');
    expect(mine[0].dataset).toBe('MR Test aggregate_only');
  });

  it('filters an aggregate_only dataset out under a stricter exposure', async () => {
    const rowLevel = await retrieveMarketContext(db, { industryKey, sizeBand, exposure: 'row_level' });
    expect(rowLevel.passages.some((p) => p.cite_id === 'MRT-AGG-01')).toBe(false);
    const display = await retrieveMarketContext(db, {
      industryKey,
      sizeBand,
      exposure: 'third_party_display',
    });
    expect(display.passages.some((p) => p.cite_id === 'MRT-AGG-01')).toBe(false);
  });

  it('ranks by full-text relevance when a query is given', async () => {
    const { passages: got } = await retrieveMarketContext(db, {
      industryKey,
      sizeBand,
      query: 'retrieval test passage',
    });
    expect(got.some((p) => p.cite_id === 'MRT-AGG-01')).toBe(true);
  });
});
