// Clerk webhook provisioning (server/clerk-webhook.ts).
//  - verifyClerkWebhook: signature check against Svix's published test vector
//    (deterministic, no network) plus tamper/missing-header rejection.
//  - handleClerkEvent: firm + profile provisioning; requires a migrated DB
//    (DATABASE_URL), skipped otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { handleClerkEvent, verifyClerkWebhook } from '../server/clerk-webhook';

// Svix's documented test vector — fixed inputs with a known-good signature.
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  svixId: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  svixTimestamp: '1614265330',
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

describe('verifyClerkWebhook', () => {
  const headers = { svixId: VECTOR.svixId, svixTimestamp: VECTOR.svixTimestamp, svixSignature: VECTOR.signature };

  it('accepts a genuine Svix signature (published test vector)', () => {
    expect(verifyClerkWebhook(VECTOR.secret, headers, VECTOR.body)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyClerkWebhook(VECTOR.secret, headers, VECTOR.body + ' ')).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyClerkWebhook('whsec_' + Buffer.from('nope').toString('base64'), headers, VECTOR.body)).toBe(false);
  });

  it('rejects missing svix headers', () => {
    expect(
      verifyClerkWebhook(VECTOR.secret, { svixId: undefined, svixTimestamp: undefined, svixSignature: undefined }, VECTOR.body),
    ).toBe(false);
  });

  it('accepts any matching signature among several in the header', () => {
    const key = Buffer.from(VECTOR.secret.slice('whsec_'.length), 'base64');
    const good = createHmac('sha256', key).update(`${VECTOR.svixId}.${VECTOR.svixTimestamp}.${VECTOR.body}`).digest('base64');
    const multi = `v1,AAAA${' '}v1,${good}`;
    expect(
      verifyClerkWebhook(VECTOR.secret, { ...headers, svixSignature: multi }, VECTOR.body),
    ).toBe(true);
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('handleClerkEvent', () => {
  let db: pg.Client;
  const orgId = 'org_webhook_test_1';
  const advisorUser = 'user_webhook_advisor_1';
  const ownerUser = 'user_webhook_owner_1';
  let companyId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await cleanup();
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.end();
  });

  async function cleanup() {
    await db.query(`delete from profiles where user_id = any($1)`, [[advisorUser, ownerUser]]);
    await db.query(`delete from companies where name = 'Webhook Co'`);
    await db.query(`delete from firms where clerk_org_id = $1 or name = 'Webhook Firm'`, [orgId]);
  }

  it('organization.created creates the firm linked to the Clerk org', async () => {
    const r = await handleClerkEvent(db, { type: 'organization.created', data: { id: orgId, name: 'Webhook Firm' } });
    expect(r.handled).toBe(true);
    const firm = (await db.query(`select id from firms where clerk_org_id = $1`, [orgId])).rows[0];
    expect(firm).toBeTruthy();
    companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'Webhook Co') returning id`, [firm.id])
    ).rows[0].id;
  });

  it('organization.created is idempotent (no duplicate firm)', async () => {
    await handleClerkEvent(db, { type: 'organization.created', data: { id: orgId, name: 'Webhook Firm' } });
    const count = (await db.query(`select count(*)::int c from firms where clerk_org_id = $1`, [orgId])).rows[0].c;
    expect(count).toBe(1);
  });

  it('membership.created provisions an advisor profile (role from org role)', async () => {
    const r = await handleClerkEvent(db, {
      type: 'organizationMembership.created',
      data: {
        organization: { id: orgId },
        public_user_data: { user_id: advisorUser, identifier: 'adv@webhook.co', first_name: 'Ada', last_name: 'Advisor' },
        role: 'org:admin',
      },
    });
    expect(r.handled).toBe(true);
    const prof = (await db.query(`select role, email, full_name, company_id from profiles where user_id = $1`, [advisorUser])).rows[0];
    expect(prof.role).toBe('admin'); // org:admin -> admin
    expect(prof.email).toBe('adv@webhook.co');
    expect(prof.full_name).toBe('Ada Advisor');
    expect(prof.company_id).toBeNull();
  });

  it('membership.created provisions an owner scoped to the company (from public_metadata)', async () => {
    const r = await handleClerkEvent(db, {
      type: 'organizationMembership.created',
      data: {
        organization: { id: orgId },
        public_user_data: { user_id: ownerUser, identifier: 'owner@webhook.co' },
        role: 'org:member',
        public_metadata: { app_role: 'owner', company_id: companyId, full_name: 'Olive Owner' },
      },
    });
    expect(r.handled).toBe(true);
    const prof = (await db.query(`select role, company_id, full_name from profiles where user_id = $1`, [ownerUser])).rows[0];
    expect(prof.role).toBe('owner'); // metadata wins over the org role
    expect(prof.company_id).toBe(companyId);
    expect(prof.full_name).toBe('Olive Owner');
  });

  it('membership.created is idempotent per user', async () => {
    await handleClerkEvent(db, {
      type: 'organizationMembership.created',
      data: { organization: { id: orgId }, public_user_data: { user_id: ownerUser, identifier: 'owner@webhook.co' }, role: 'org:member' },
    });
    const count = (await db.query(`select count(*)::int c from profiles where user_id = $1`, [ownerUser])).rows[0].c;
    expect(count).toBe(1);
  });

  it('membership for an unknown org throws (so Svix retries)', async () => {
    await expect(
      handleClerkEvent(db, {
        type: 'organizationMembership.created',
        data: { organization: { id: 'org_does_not_exist' }, public_user_data: { user_id: 'user_x' }, role: 'org:member' },
      }),
    ).rejects.toThrow(/no firm/i);
  });
});
