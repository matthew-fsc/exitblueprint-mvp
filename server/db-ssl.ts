// TLS configuration for the compute service's Postgres pool.
//
// Why this exists: production points DATABASE_URL at the Supabase pooler, whose
// certificate chains to Supabase's own private CA — not in Node's default trust
// store. Recent `pg` also treats an in-URL `sslmode=require` as *verify-full*, so
// an otherwise-correct connection is rejected with SELF_SIGNED_CERT_IN_CHAIN and
// the service can't reach the DB (webhook provisioning, functions, everything).
//
// Fix: decide TLS ourselves and control it via the pg `ssl` option — but an
// in-URL `sslmode` *overrides* an explicit `ssl` object (verified against pg), so
// we strip `sslmode` from the connection string and set `ssl` in code. Provide the
// Supabase CA (DATABASE_CA_CERT inline PEM, or PGSSLROOTCERT path) to get full
// verification; otherwise connect encrypted but unverified and let the caller warn.
import { readFileSync } from 'node:fs';

export type DbSsl = false | { rejectUnauthorized: false } | { ca: string; rejectUnauthorized: true };

export interface DbConnection {
  connectionString: string; // `sslmode` removed so our `ssl` wins
  ssl: DbSsl;
  tls: boolean; // whether TLS is used at all
  verified: boolean; // whether the server cert is verified against a CA
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function resolveDbConnection(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): DbConnection {
  // Parse to read + strip sslmode. If the URL can't be parsed (unusual), fall back
  // to the raw string and infer sslmode via regex.
  let connectionString = databaseUrl;
  let sslmode: string | undefined;
  let host = '';
  try {
    const u = new URL(databaseUrl);
    host = u.hostname;
    sslmode = u.searchParams.get('sslmode')?.toLowerCase() ?? undefined;
    u.searchParams.delete('sslmode');
    connectionString = u.toString();
  } catch {
    sslmode = /[?&]sslmode=([a-z-]+)/i.exec(databaseUrl)?.[1]?.toLowerCase();
    connectionString = databaseUrl.replace(/([?&])sslmode=[^&]*(&|$)/i, (_m, pre, post) => (post === '&' ? pre : ''));
  }

  // TLS on when sslmode asks for it; with no sslmode, on for a remote host, off
  // for local dev / CI (a plain local Postgres has no TLS).
  const tls = sslmode ? sslmode !== 'disable' : host !== '' && !isLocalHost(host);
  if (!tls) return { connectionString, ssl: false, tls: false, verified: false };

  const caInline = env.DATABASE_CA_CERT?.trim();
  const caPath = env.PGSSLROOTCERT?.trim();
  const ca = caInline || (caPath ? readFileSync(caPath, 'utf8') : undefined);
  if (ca) return { connectionString, ssl: { ca, rejectUnauthorized: true }, tls: true, verified: true };
  return { connectionString, ssl: { rejectUnauthorized: false }, tls: true, verified: false };
}
