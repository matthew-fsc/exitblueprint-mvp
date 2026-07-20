// View-only external collaborators (CPA, attorney, …) per engagement. Requires a
// migrated database (DATABASE_URL); skipped otherwise. Proves the dev-path invite
// creates a read-only collaborator login scoped to a SINGLE engagement, writes
// the roster row, is idempotent per (engagement, email), validates the email, and
// that revoke cuts access (deletes the profile, marks the row revoked).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { inviteCollaborator, revokeCollaborator } from '../server/collaborators';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('inviteCollaborator / revokeCollaborator', () => {
  let db: pg.Client;
  let firmId: string;
  let companyId: string;
  let engagementId: string;
  let otherEngagementId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    firmId = (await db.query(`insert into firms (name) values ('Collab Test Firm') returning id`)).rows[0].id;
    companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'Collab Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    otherEngagementId = (
      await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from engagement_collaborators where firm_id = $1`, [firmId]);
    await db.query(`delete from profiles where firm_id = $1`, [firmId]);
    await db.query(`delete from auth.users where lower(email) = 'cpa.invite@test.co'`);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('rejects an invalid email', async () => {
    await expect(inviteCollaborator(db, firmId, engagementId, 'nope', null, 'cpa', null)).rejects.toThrow(
      /valid email/,
    );
  });

  it('rejects an engagement from another firm', async () => {
    const otherFirm = (await db.query(`insert into firms (name) values ('Other') returning id`)).rows[0].id;
    await expect(
      inviteCollaborator(db, otherFirm, engagementId, 'x@test.co', null, 'cpa', null),
    ).rejects.toThrow(/engagement not found/);
    await db.query(`delete from firms where id = $1`, [otherFirm]);
  });

  it('creates a read-only collaborator scoped to the one engagement, plus a roster row', async () => {
    const r = await inviteCollaborator(db, firmId, engagementId, '  CPA.Invite@Test.co ', 'Pat CPA', 'cpa', null);
    expect(r.status).toBe('invited');
    expect(r.email).toBe('cpa.invite@test.co'); // trimmed + lowercased
    expect(r.kind).toBe('cpa');
    expect(r.dev_password).toBe('demo');

    const prof = (
      await db.query(
        `select role, company_id, firm_id, engagement_id from profiles where email = 'cpa.invite@test.co'`,
      )
    ).rows;
    expect(prof).toHaveLength(1);
    expect(prof[0].role).toBe('collaborator');
    expect(prof[0].engagement_id).toBe(engagementId);
    expect(prof[0].company_id).toBe(companyId);
    expect(prof[0].firm_id).toBe(firmId);

    const roster = (
      await db.query(
        `select status, kind, user_id from engagement_collaborators where engagement_id = $1 and email = 'cpa.invite@test.co'`,
        [engagementId],
      )
    ).rows;
    expect(roster).toHaveLength(1);
    expect(roster[0].status).toBe('active');
    expect(roster[0].kind).toBe('cpa');
    expect(roster[0].user_id).toBeTruthy();
  });

  it('is idempotent per (engagement, email)', async () => {
    const r = await inviteCollaborator(db, firmId, engagementId, 'cpa.invite@test.co', 'Pat CPA', 'attorney', null);
    expect(r.status).toBe('exists');
    const count = (
      await db.query(
        `select count(*)::int c from engagement_collaborators where engagement_id = $1 and email = 'cpa.invite@test.co'`,
        [engagementId],
      )
    ).rows[0].c;
    expect(count).toBe(1);
  });

  it('defaults an unknown kind to other', async () => {
    const r = await inviteCollaborator(db, firmId, otherEngagementId, 'other.kind@test.co', null, 'banker', null);
    expect(r.kind).toBe('other');
    await db.query(`delete from profiles where email = 'other.kind@test.co'`);
    await db.query(`delete from auth.users where lower(email) = 'other.kind@test.co'`);
    await db.query(`delete from engagement_collaborators where email = 'other.kind@test.co'`);
  });

  it('revoke deletes the collaborator profile and marks the roster row revoked', async () => {
    const row = (
      await db.query(
        `select id from engagement_collaborators where engagement_id = $1 and email = 'cpa.invite@test.co'`,
        [engagementId],
      )
    ).rows[0];
    await revokeCollaborator(db, firmId, row.id);

    const prof = (await db.query(`select id from profiles where email = 'cpa.invite@test.co'`)).rows;
    expect(prof).toHaveLength(0); // access cut

    const roster = (
      await db.query(`select status, user_id, revoked_at from engagement_collaborators where id = $1`, [row.id])
    ).rows[0];
    expect(roster.status).toBe('revoked');
    expect(roster.user_id).toBeNull();
    expect(roster.revoked_at).toBeTruthy();
  });

  it('revoke rejects a row from another firm', async () => {
    const otherFirm = (await db.query(`insert into firms (name) values ('Other2') returning id`)).rows[0].id;
    const row = (
      await db.query(
        `select id from engagement_collaborators where engagement_id = $1 limit 1`,
        [engagementId],
      )
    ).rows[0];
    await expect(revokeCollaborator(db, otherFirm, row.id)).rejects.toThrow(/collaborator not found/);
    await db.query(`delete from firms where id = $1`, [otherFirm]);
  });
});
