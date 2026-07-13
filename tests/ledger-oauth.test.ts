// Ledger OAuth lifecycle (begin → complete → disconnect). Requires a migrated
// database (DATABASE_URL); skipped otherwise. Exercises the dev-simulation path
// (no provider env vars set), which is the same code path minus the external
// token exchange, and proves: a pending state is consumed exactly once, tokens
// land only in the quarantined credentials table, connect is idempotent per
// (company, provider), and disconnect keeps the row while wiping the secret.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { beginLedgerConnect, completeLedgerConnect, disconnectLedger, providerConfig } from '../server/ledger-oauth';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('ledger OAuth lifecycle (dev simulation)', () => {
  let db: pg.Client;
  let firmId: string;
  let companyId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    firmId = (await db.query(`insert into firms (name) values ('OAuth Test Firm') returning id`)).rows[0].id;
    companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'OAuth Co') returning id`, [firmId])
    ).rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(
      `delete from ledger_credentials where connection_id in
         (select id from ledger_connections where firm_id = $1)`,
      [firmId],
    );
    await db.query(`delete from ledger_oauth_states where firm_id = $1`, [firmId]);
    await db.query(`delete from ledger_connections where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('runs in dev simulation when no provider app is configured', () => {
    // These tests assume no live QuickBooks/Xero app in the environment.
    expect(providerConfig('quickbooks')).toBeNull();
    expect(providerConfig('xero')).toBeNull();
  });

  it('begins in dev mode and records a pending state', async () => {
    const r = await beginLedgerConnect(db, { companyId, provider: 'quickbooks', returnTo: '/portal/connect' });
    expect(r.mode).toBe('dev');
    expect(r.authorize_url).toBeNull();
    const pending = (
      await db.query(`select company_id, return_to from ledger_oauth_states where state = $1`, [r.state])
    ).rows[0];
    expect(pending.company_id).toBe(companyId);
    expect(pending.return_to).toBe('/portal/connect');
  });

  it('completes the connection, quarantines the token, and returns where to go back', async () => {
    const begin = await beginLedgerConnect(db, { companyId, provider: 'quickbooks', returnTo: '/portal/connect' });
    const done = await completeLedgerConnect(db, { state: begin.state });
    expect(done.status).toBe('connected');
    expect(done.return_to).toBe('/portal/connect');

    const conn = (
      await db.query(`select status, realm_id, disconnected_at from ledger_connections where id = $1`, [done.connection_id])
    ).rows[0];
    expect(conn.status).toBe('connected');
    expect(conn.realm_id).toBeTruthy();
    expect(conn.disconnected_at).toBeNull();

    const cred = (
      await db.query(`select access_token, refresh_token from ledger_credentials where connection_id = $1`, [done.connection_id])
    ).rows[0];
    expect(cred.access_token).toMatch(/^dev-access-/);
    expect(cred.refresh_token).toMatch(/^dev-refresh-/);

    // The pending state is consumed exactly once.
    const left = await db.query(`select 1 from ledger_oauth_states where state = $1`, [begin.state]);
    expect(left.rowCount).toBe(0);
  });

  it('rejects a reused or unknown state', async () => {
    await expect(completeLedgerConnect(db, { state: 'never-issued' })).rejects.toThrow(/invalid or expired/);
  });

  it('is idempotent per (company, provider): reconnect reuses the same row', async () => {
    const before = (
      await db.query(`select count(*)::int c from ledger_connections where company_id = $1 and provider = 'quickbooks'`, [companyId])
    ).rows[0].c;
    const begin = await beginLedgerConnect(db, { companyId, provider: 'quickbooks' });
    await completeLedgerConnect(db, { state: begin.state });
    const after = (
      await db.query(`select count(*)::int c from ledger_connections where company_id = $1 and provider = 'quickbooks'`, [companyId])
    ).rows[0].c;
    expect(after).toBe(before); // upsert, not a duplicate
  });

  it('disconnects: keeps the row, flips status, wipes the token', async () => {
    const conn = (
      await db.query(`select id from ledger_connections where company_id = $1 and provider = 'quickbooks'`, [companyId])
    ).rows[0].id;
    const r = await disconnectLedger(db, { connectionId: conn });
    expect(r.status).toBe('disconnected');

    const row = (
      await db.query(`select status, disconnected_at from ledger_connections where id = $1`, [conn])
    ).rows[0];
    expect(row.status).toBe('disconnected');
    expect(row.disconnected_at).not.toBeNull();

    const cred = await db.query(`select 1 from ledger_credentials where connection_id = $1`, [conn]);
    expect(cred.rowCount).toBe(0); // token gone
  });
});
