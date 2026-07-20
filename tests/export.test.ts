// Self-serve engagement data export (docs/35 Phase 9). Requires a migrated +
// seeded database (DATABASE_URL); skipped otherwise. Proves the export gathers the
// engagement's business data, excludes document bytes, and refuses a foreign firm.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { exportEngagement } from '../server/export';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('exportEngagement', () => {
  let db: pg.Client;
  let firmId: string;
  let otherFirmId: string;
  let companyId: string;
  let engagementId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    firmId = (await db.query(`insert into firms (name) values ('Export Test Firm') returning id`)).rows[0].id;
    otherFirmId = (await db.query(`insert into firms (name) values ('Export Other Firm') returning id`)).rows[0].id;
    companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'Export Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    // One engagement-log entry so a child collection is non-empty.
    await db.query(
      `insert into engagement_log (firm_id, engagement_id, kind, title, detail) values ($1, $2, 'note', 'Kickoff', 'Notes')`,
      [firmId, engagementId],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from engagement_log where firm_id = $1`, [firmId]);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = any($1)`, [[firmId, otherFirmId]]);
    await db.end();
  });

  it('exports the engagement with company, log, and stable envelope', async () => {
    const out = await exportEngagement(db, firmId, engagementId);
    expect(out.schema_version).toBe(1);
    expect(out.firm.id).toBe(firmId);
    expect((out.engagement as { id: string }).id).toBe(engagementId);
    expect((out.company as { id: string }).id).toBe(companyId);
    expect(out.engagement_log).toHaveLength(1);
    expect((out.engagement_log[0] as { title: string }).title).toBe('Kickoff');
    expect(out.counts.engagement_log).toBe(1);
    expect(typeof out.generated_at).toBe('string');
  });

  it('exports documents as metadata only — never the encrypted bytes', async () => {
    const out = await exportEngagement(db, firmId, engagementId);
    // The documents collection carries no byte/content column, whatever rows exist.
    for (const d of out.documents) {
      expect(d).not.toHaveProperty('bytes');
      expect(d).not.toHaveProperty('content');
    }
  });

  it('refuses an engagement that is not the given firm’s', async () => {
    await expect(exportEngagement(db, otherFirmId, engagementId)).rejects.toThrow(/not found/);
  });
});
