// Firm-staff invitation (self-serve team management, docs/35 #1). Requires a
// migrated database (DATABASE_URL); skipped otherwise. Proves the dev-path invite
// creates a staff login + profile in the caller's firm, validates email/role, is
// idempotent per email, and reports seat usage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { inviteAdvisor } from '../server/invite-advisor';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('inviteAdvisor', () => {
  let db: pg.Client;
  let firmId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    firmId = (await db.query(`insert into firms (name) values ('Advisor Invite Firm') returning id`)).rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from profiles where firm_id = $1`, [firmId]);
    await db.query(`delete from auth.users where lower(email) in ('adv.invite@test.co','rev.invite@test.co')`);
    await db.query(`delete from firm_subscriptions where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('rejects an invalid email', async () => {
    await expect(inviteAdvisor(db, firmId, 'not-an-email', null, 'advisor')).rejects.toThrow(/valid email/);
  });

  it('rejects an unknown / non-staff role', async () => {
    await expect(inviteAdvisor(db, firmId, 'adv.invite@test.co', null, 'owner')).rejects.toThrow(/role must be/);
  });

  it('creates a staff login and profile in the firm', async () => {
    const r = await inviteAdvisor(db, firmId, '  Adv.Invite@Test.co ', 'Jo Advisor', 'advisor');
    expect(r.status).toBe('invited');
    expect(r.email).toBe('adv.invite@test.co'); // trimmed + lowercased
    expect(r.role).toBe('advisor');
    expect(r.seatsUsed).toBe(1);
    expect(r.seatLimit).toBeNull(); // no plan attached = unlimited
    const prof = (
      await db.query(
        `select p.role, p.firm_id, u.email
         from profiles p join auth.users u on u.id::text = p.user_id
         where p.firm_id = $1 and p.role = 'advisor'`,
        [firmId],
      )
    ).rows;
    expect(prof).toHaveLength(1);
    expect(prof[0].email).toBe('adv.invite@test.co');
  });

  it('is idempotent per email (returns exists, no duplicate, no seat consumed)', async () => {
    const r = await inviteAdvisor(db, firmId, 'adv.invite@test.co', 'Jo Advisor', 'advisor');
    expect(r.status).toBe('exists');
    const count = (
      await db.query(`select count(*)::int c from profiles where firm_id = $1`, [firmId])
    ).rows[0].c;
    expect(count).toBe(1);
  });

  it('invites a reviewer with its own seat', async () => {
    const r = await inviteAdvisor(db, firmId, 'rev.invite@test.co', null, 'reviewer');
    expect(r.status).toBe('invited');
    expect(r.role).toBe('reviewer');
    expect(r.seatsUsed).toBe(2);
  });
});
