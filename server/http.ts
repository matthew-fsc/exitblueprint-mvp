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
import { handleClerkEvent, verifyClerkWebhook, type ClerkEvent } from './clerk-webhook';

const PORT = Number(process.env.PORT ?? 8787);
// Verify access tokens against whichever signing regime the project uses. A
// legacy project sets FUNCTIONS_JWT_SECRET (HS256); a project on asymmetric
// signing keys sets SUPABASE_URL so tokens verify against its JWKS. Setting
// both is fine (and correct mid-rotation) — the token's `alg` picks the path.
// Normalize a URL-ish env value: trim (a pasted trailing newline/space in a
// host's env UI otherwise makes `new URL` throw), drop trailing slashes, and
// tolerate a missing scheme (`ref.supabase.co` → `https://ref.supabase.co`) —
// the most common misconfiguration when copying a project URL by hand.
function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const v = raw?.trim().replace(/\/+$/, '');
  if (!v) return undefined;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}
const SUPABASE_URL = normalizeBaseUrl(process.env.SUPABASE_URL);
// Clerk cutover (docs/30): once the app authenticates via Clerk, tokens are Clerk
// session JWTs. Point the JWKS at Clerk's key set to verify them. CLERK_JWKS_URL
// wins over the Supabase JWKS when set (both are asymmetric, so one key set is
// used at a time); FUNCTIONS_JWT_SECRET (HS256) still works alongside for dev/CI.
const CLERK_JWKS_URL = normalizeBaseUrl(process.env.CLERK_JWKS_URL);
const jwksUrl =
  CLERK_JWKS_URL ?? (SUPABASE_URL ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` : undefined);
if (!process.env.FUNCTIONS_JWT_SECRET && !jwksUrl) {
  console.error(
    'Set FUNCTIONS_JWT_SECRET (legacy HS256), SUPABASE_URL (Supabase JWKS), or CLERK_JWKS_URL (Clerk JWKS) to verify tokens',
  );
  process.exit(1);
}
// Fail with a clear, actionable message instead of a cryptic `new URL` stack
// trace deep in the JWKS client when the value is malformed.
if (jwksUrl) {
  try {
    new URL(jwksUrl);
  } catch {
    const badVar = CLERK_JWKS_URL ? 'CLERK_JWKS_URL' : 'SUPABASE_URL';
    console.error(
      `${badVar} is not a valid URL (got "${jwksUrl}"). Set it to a full URL, ` +
        'e.g. SUPABASE_URL=https://<ref>.supabase.co or CLERK_JWKS_URL=https://<clerk-domain>/.well-known/jwks.json',
    );
    process.exit(1);
  }
}
const verifyToken = makeVerifyToken({
  hsSecret: process.env.FUNCTIONS_JWT_SECRET,
  jwksUrl,
});
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (the service-role Postgres connection string)');
  process.exit(1);
}
// Comma-separated allowed origins for CORS; '*' by default (tighten in prod).
const ALLOWED_ORIGIN = process.env.FUNCTIONS_ALLOWED_ORIGIN ?? '*';

// Clerk webhook signing secret (Svix `whsec_...`, from the Clerk dashboard).
// Set to enable POST /webhooks/clerk (automatic firm/advisor/owner provisioning,
// docs/30 §5). Unset → the endpoint replies 503 and provisioning stays manual
// (scripts/admin.ts).
const CLERK_WEBHOOK_SIGNING_SECRET = process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim();
// Reject webhooks whose signed timestamp is older than this (replay defense).
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// Document encryption at rest falls back to a weak dev key if EB_DOCUMENT_KEY is
// unset — safe for dev, not for production. Warn loudly rather than silently
// protecting client documents with a publicly-known key (docs/14).
if (process.env.NODE_ENV === 'production' && !process.env.EB_DOCUMENT_KEY) {
  console.warn(
    'WARNING: EB_DOCUMENT_KEY is not set — uploaded documents are encrypted with the ' +
      'insecure dev default key. Set a 32-byte hex key before storing real client documents.',
  );
}

// connectionTimeoutMillis is essential for the deploy health check: without it,
// a slow/unreachable DB makes a query hang indefinitely (pg has no default
// connect timeout). That is what previously hung /health and made Render time
// the whole deploy out. Bound it so any DB call fails fast instead.
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 10_000,
});

// Bound a promise so a hung dependency (a stalled DB connect) can never make an
// endpoint hang forever — it rejects after `ms` instead.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

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

  // Liveness — Render's deploy gate (healthCheckPath). It must confirm only that
  // the process is up and serving HTTP, with NO external dependency: coupling the
  // deploy gate to the DB is what let a slow/unreachable DB hang the request and
  // time the deploy out (restart loop). A DB blip must not fail the deploy or kill
  // a running instance; use /ready for the DB-aware signal.
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
    return json(res, 200, { ok: true });
  }

  // Readiness — is the service actually able to serve requests (DB reachable)?
  // Bounded so it always responds quickly (never hangs): for monitoring / a load
  // balancer, not the deploy gate.
  if (req.method === 'GET' && url.pathname === '/ready') {
    try {
      await withTimeout(pool.query('select 1'), 5_000, 'readiness db check');
      return json(res, 200, { ok: true, db: true });
    } catch {
      return json(res, 503, { ok: false, db: false });
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

  // Clerk webhook (Svix-signed) — automatic provisioning (docs/30 §5). Verified
  // against the raw body, then handled with the service role (a trusted system
  // caller, RLS-bypass like scripts/admin.ts). Returns 2xx on handled/duplicate,
  // 400 on a bad signature, 5xx on a transient failure so Svix retries.
  if (req.method === 'POST' && url.pathname === '/webhooks/clerk') {
    if (!CLERK_WEBHOOK_SIGNING_SECRET) return json(res, 503, { message: 'clerk webhook not configured' });
    const raw = await readBody(req);
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const svixTimestamp = header('svix-timestamp');
    const ts = Number(svixTimestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > WEBHOOK_TOLERANCE_SECONDS) {
      return json(res, 400, { message: 'stale or missing webhook timestamp' });
    }
    const ok = verifyClerkWebhook(
      CLERK_WEBHOOK_SIGNING_SECRET,
      { svixId: header('svix-id'), svixTimestamp, svixSignature: header('svix-signature') },
      raw,
    );
    if (!ok) return json(res, 400, { message: 'invalid webhook signature' });

    let event: ClerkEvent;
    try {
      event = JSON.parse(raw) as ClerkEvent;
    } catch {
      return json(res, 400, { message: 'invalid JSON body' });
    }
    const c = await pool.connect();
    try {
      const result = await handleClerkEvent(c, event);
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      // 5xx so Svix retries (e.g. the firm's organization.created hasn't landed).
      return json(res, 500, { message: (e as Error).message });
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
