// TLS resolution for the compute-service Postgres pool (server/db-ssl.ts). Pure,
// no DB — covers the branches that decide whether/how the pool uses TLS. The
// production symptom this guards against: Supabase's pooler cert chains to
// Supabase's private CA, and an in-URL sslmode=require makes pg do verify-full →
// SELF_SIGNED_CERT_IN_CHAIN. We strip sslmode and control ssl in code.
import { describe, expect, it } from 'vitest';
import { resolveDbConnection } from '../server/db-ssl';

const POOLER = 'postgresql://postgres.ref:p%40ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require';
const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

describe('resolveDbConnection', () => {
  it('strips sslmode from the connection string (so our ssl config wins over verify-full)', () => {
    const r = resolveDbConnection(POOLER, {});
    expect(r.connectionString).not.toMatch(/sslmode/i);
    expect(r.connectionString).toContain('pooler.supabase.com'); // host + password preserved
    expect(r.connectionString).toContain('p%40ss');
  });

  it('enables encrypted-but-unverified TLS for a remote pooler with no CA', () => {
    const r = resolveDbConnection(POOLER, {});
    expect(r.tls).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('enables full verification when a CA is provided inline', () => {
    const r = resolveDbConnection(POOLER, { DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----' });
    expect(r.tls).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.ssl).toMatchObject({ rejectUnauthorized: true });
    expect((r.ssl as { ca: string }).ca).toContain('BEGIN CERTIFICATE');
  });

  it('uses no TLS for a local dev connection (no sslmode, localhost)', () => {
    const r = resolveDbConnection(LOCAL, {});
    expect(r.tls).toBe(false);
    expect(r.ssl).toBe(false);
    expect(r.connectionString).toBe(LOCAL);
  });

  it('honors sslmode=disable explicitly', () => {
    const r = resolveDbConnection('postgresql://u:p@some.remote.host:5432/db?sslmode=disable', {});
    expect(r.tls).toBe(false);
    expect(r.ssl).toBe(false);
  });

  it('defaults a remote host with no sslmode to TLS on', () => {
    const r = resolveDbConnection('postgresql://u:p@db.example.com:5432/db', {});
    expect(r.tls).toBe(true);
  });
});
