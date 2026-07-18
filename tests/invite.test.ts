// Advisor-initiated owner invitation. Requires a migrated database
// (DATABASE_URL); skipped otherwise. Proves an invite creates the owner login +
// owner profile, is idempotent per company, and validates the email.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { inviteOwner } from '../server/invite';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('inviteOwner', () => {
  let db: pg.Client;
  let firmId: string;
  let companyId: string;
  let engagementId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    firmId = (await db.query(`insert into firms (name) values ('Invite Test Firm') returning id`)).rows[0].id;
    companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'Invite Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from profiles where firm_id = $1`, [firmId]);
    await db.query(`delete from auth.users where lower(email) = 'owner.invite@test.co'`);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('rejects an invalid email', async () => {
    await expect(inviteOwner(db, engagementId, 'not-an-email', null)).rejects.toThrow(/valid email/);
  });

  it('creates the owner login and profile, scoped to the company', async () => {
    const r = await inviteOwner(db, engagementId, '  Owner.Invite@Test.co ', 'Casey Owner');
    expect(r.status).toBe('invited');
    expect(r.email).toBe('owner.invite@test.co'); // trimmed + lowercased
    const prof = (
      await db.query(
        `select p.role, p.company_id, p.firm_id, u.email
         from profiles p join auth.users u on u.id::text = p.user_id
         where p.company_id = $1 and p.role = 'owner'`,
        [companyId],
      )
    ).rows;
    expect(prof).toHaveLength(1);
    expect(prof[0].email).toBe('owner.invite@test.co');
    expect(prof[0].firm_id).toBe(firmId);
  });

  it('is idempotent per company (returns the existing owner, no duplicate)', async () => {
    const r = await inviteOwner(db, engagementId, 'someone.else@test.co', 'Someone Else');
    expect(r.status).toBe('exists');
    expect(r.email).toBe('owner.invite@test.co');
    const count = (
      await db.query(`select count(*)::int c from profiles where company_id = $1 and role = 'owner'`, [companyId])
    ).rows[0].c;
    expect(count).toBe(1);
  });
});
