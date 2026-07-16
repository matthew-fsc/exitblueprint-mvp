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
import pg from 'pg';
import { handleFunctionCall } from './functions';
import { makeVerifyToken, type Claims } from './auth-jwt';
import { verifyDocumentToken } from './documents/signed-url';
import { getDocumentBytes } from './documents/pipeline';
import { logAccess } from './audit';

const PORT = Number(process.env.PORT ?? 8787);
// Verify access tokens against whichever signing regime the project uses. A
// legacy project sets FUNCTIONS_JWT_SECRET (HS256); a project on asymmetric
// signing keys sets SUPABASE_URL so tokens verify against its JWKS. Setting
// both is fine (and correct mid-rotation) — the token's `alg` picks the path.
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
if (!process.env.FUNCTIONS_JWT_SECRET && !SUPABASE_URL) {
  console.error('Set FUNCTIONS_JWT_SECRET (legacy HS256) or SUPABASE_URL (asymmetric JWKS) to verify tokens');
  process.exit(1);
}
const verifyToken = makeVerifyToken({
  hsSecret: process.env.FUNCTIONS_JWT_SECRET,
  jwksUrl: SUPABASE_URL ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` : undefined,
});
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (the service-role Postgres connection string)');
  process.exit(1);
}
// Comma-separated allowed origins for CORS; '*' by default (tighten in prod).
const ALLOWED_ORIGIN = process.env.FUNCTIONS_ALLOWED_ORIGIN ?? '*';

// Document encryption at rest falls back to a weak dev key if EB_DOCUMENT_KEY is
// unset — safe for dev, not for production. Warn loudly rather than silently
// protecting client documents with a publicly-known key (docs/14).
if (process.env.NODE_ENV === 'production' && !process.env.EB_DOCUMENT_KEY) {
  console.warn(
    'WARNING: EB_DOCUMENT_KEY is not set — uploaded documents are encrypted with the ' +
      'insecure dev default key. Set a 32-byte hex key before storing real client documents.',
  );
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

function bearer(req: IncomingMessage): Promise<Claims | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return Promise.resolve(null);
  return verifyToken(auth.slice(7));
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

  // Short-expiry signed document download (R5). No JWT: the HMAC token in the
  // query authorizes access to exactly one document until it expires.
  if (req.method === 'GET' && url.pathname === '/documents/download') {
    const docId = url.searchParams.get('doc') ?? '';
    const token = url.searchParams.get('token') ?? '';
    if (!docId || !verifyDocumentToken(docId, token)) {
      return json(res, 403, { message: 'invalid or expired document token' });
    }
    const c = await pool.connect();
    try {
      const d = await getDocumentBytes(c, docId);
      if (!d) return json(res, 404, { message: 'document not found' });
      const meta = (await c.query(`select firm_id, engagement_id from documents where id = $1`, [docId]))
        .rows[0];
      if (meta) {
        await logAccess(c, {
          firmId: meta.firm_id,
          action: 'document.download',
          resourceType: 'document',
          resourceId: docId,
          engagementId: meta.engagement_id ?? null,
          detail: { via: 'signed-url' },
        });
      }
      res.statusCode = 200;
      res.setHeader('content-type', d.mime || 'application/octet-stream');
      res.setHeader('content-disposition', `inline; filename="${d.filename}"`);
      return res.end(Buffer.from(d.bytes));
    } finally {
      c.release();
    }
  }

  if (req.method === 'POST' && url.pathname.startsWith('/functions/v1/')) {
    const claims = await bearer(req);
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
      if (result.kind === 'binary') {
        res.statusCode = 200;
        res.setHeader('content-type', result.mime || 'application/octet-stream');
        res.setHeader('content-disposition', `inline; filename="${result.filename}"`);
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
