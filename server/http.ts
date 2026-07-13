// Production compute service — the single Node deployable that serves every
// `/functions/v1/<name>` call for real (docs/10-production-readiness.md, Phase 1,
// "one Node service" runtime). It mounts the same server/functions.ts router the
// dev emulator uses; the difference is only the transport and the JWT source:
//
//   - Auth + REST stay with real Supabase (the frontend talks to Supabase for
//     those). This service ONLY serves functions.
//   - JWTs are real Supabase access tokens, verified HS256 against the project's
//     JWT secret (FUNCTIONS_JWT_SECRET). No dev password, no dev secret.
//   - Postgres is the real project DB; DATABASE_URL must be the service-role
//     (bypass-RLS) connection string. Per-request queries that must respect RLS
//     run through asUser (set role authenticated + the caller's claims), exactly
//     as PostgREST / the dev emulator do.
//
// Run locally:  DATABASE_URL=... FUNCTIONS_JWT_SECRET=... tsx server/http.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { handleFunctionCall } from './functions';

const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = process.env.FUNCTIONS_JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FUNCTIONS_JWT_SECRET is required (the Supabase project JWT secret)');
  process.exit(1);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (the service-role Postgres connection string)');
  process.exit(1);
}
// Comma-separated allowed origins for CORS; '*' by default (tighten in prod).
const ALLOWED_ORIGIN = process.env.FUNCTIONS_ALLOWED_ORIGIN ?? '*';

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

interface Claims {
  sub: string;
  role?: string;
  exp?: number;
  [k: string]: unknown;
}

// Standard HS256 JWT verification (Supabase legacy access tokens). Returns the
// claims or null. Constant-time signature compare; rejects expired tokens.
function verifyJwt(token: string): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', JWT_SECRET as string)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    return null;
  }
  if (claims.exp && claims.exp < Date.now() / 1000) return null;
  if (!claims.sub) return null;
  return claims;
}

function bearer(req: IncomingMessage): Claims | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyJwt(auth.slice(7));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function setCors(res: ServerResponse) {
  res.setHeader('access-control-allow-origin', ALLOWED_ORIGIN);
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, apikey, content-type, x-client-info');
  res.setHeader('access-control-max-age', '86400');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

// Run fn as the authenticated caller (RLS enforced), inside a transaction.
async function asUser<T>(claims: Claims, fn: (db: pg.ClientBase) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await c.query('set local role authenticated');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    try {
      await pool.query('select 1');
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 503, { ok: false });
    }
  }

  if (req.method === 'POST' && url.pathname.startsWith('/functions/v1/')) {
    const claims = bearer(req);
    if (!claims) return json(res, 401, { message: 'invalid or missing token' });
    const name = url.pathname.replace('/functions/v1/', '');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { message: 'invalid JSON body' });
    }

    const service = await pool.connect();
    try {
      const result = await handleFunctionCall(name, body, {
        userId: claims.sub,
        asUser: (fn) => asUser(claims, fn),
        service,
      });
      if (result.kind === 'pdf') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/pdf');
        res.setHeader('content-disposition', `attachment; filename="${result.filename}"`);
        return res.end(Buffer.from(result.buffer));
      }
      return json(res, result.status, result.body);
    } catch (e) {
      return json(res, 500, { message: (e as Error).message });
    } finally {
      service.release();
    }
  }

  return json(res, 404, { message: 'not found' });
});

server.listen(PORT, () => {
  console.log(`functions service listening on :${PORT} (serving /functions/v1/*)`);
});
