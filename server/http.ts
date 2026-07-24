// Production compute service — the single Node deployable that serves every
// `/functions/v1/<name>` call for real (docs/archive/10-production-readiness.md, Phase 1,
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
import { getDocumentBytes, sanitizeFilename } from './documents/pipeline';
import { logAccess } from './audit';
import { handleClerkEvent, verifyClerkWebhook, type ClerkEvent } from './clerk-webhook';
import { resolveDbConnection } from './db-ssl';
import { parseAllowedOrigins, resolveCorsOrigin } from './cors';
import { createRateLimiter, type RateLimiter } from './ratelimit';
import {
  findStaleEngagements,
  findStalledTasks,
  findReassessmentDue,
  findReassessmentReady,
  verifyWebhookSecret,
} from './scheduled';
import { initObservability, captureError, logRequest } from './observability';
import { isPlatformSuperadmin } from './platform-admin';
import { platformMetrics } from './platform-metrics';
import { financialCorpus } from './financial-corpus';
import { moatMetrics } from './moat-metrics';
import { readCalibration } from './calibration';
import { benchSummary } from './bench-metrics';
import {
  applyStripeEvent,
  verifyStripeSignature,
  stripeWebhookSecret,
  stripeConfigured,
} from './stripe';

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
// Parsed into a list because Access-Control-Allow-Origin is a single-origin (or
// '*') header — emitting the raw comma-joined string is invalid and every browser
// rejects it, which shows up app-wide as "we couldn't reach the server". See
// server/cors.ts; the request's own Origin is echoed back per-request in setCors.
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.FUNCTIONS_ALLOWED_ORIGIN);

// Clerk webhook signing secret (Svix `whsec_...`, from the Clerk dashboard).
// Set to enable POST /webhooks/clerk (automatic firm/advisor/owner provisioning,
// docs/30 §5). Unset → the endpoint replies 503 and provisioning stays manual
// (scripts/admin.ts).
const CLERK_WEBHOOK_SIGNING_SECRET = process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim();
// Reject webhooks whose signed timestamp is older than this (replay defense).
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// Shared secret for the continuous-evaluation webhooks (docs/07) that an external
// n8n instance calls on a schedule. Set to enable POST /webhooks/scheduled/*;
// unset → those endpoints reply 503 (disabled), mirroring the Clerk webhook.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET?.trim();

// Rate limiting for the two UNAUTHENTICATED external webhook routes
// (/webhooks/clerk and /webhooks/scheduled/*, docs/24 item D2). They are already
// signature/secret-gated, but a flood from a single source could still exhaust
// the DB pool or burn CPU on signature verification before that gate runs. This
// bounds request volume per client IP. Configurable via env; defaults to 60
// requests per 60s window. Not an auth boundary — just volume hygiene.
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const WEBHOOK_RATE_LIMIT = envInt('WEBHOOK_RATE_LIMIT', 60);
const WEBHOOK_RATE_WINDOW_SEC = envInt('WEBHOOK_RATE_WINDOW_SEC', 60);
const webhookLimiter = createRateLimiter({
  limit: WEBHOOK_RATE_LIMIT,
  windowMs: WEBHOOK_RATE_WINDOW_SEC * 1000,
});

// The authenticated function surface (/functions/v1/*) gets its own, more
// generous per-IP window. It runs BEFORE token verification, so it caps the CPU
// a flood of bad/expensive tokens can burn on JWKS verify and the DB pool it
// would otherwise reach — without throttling a real advisor whose dashboard
// fires a burst of calls. Keyed by IP (pre-auth, so no principal yet); like the
// webhook limiter it is in-memory per-instance (volume hygiene, not an auth
// boundary). Tunable via env for a NAT'd firm that needs more headroom.
const API_RATE_LIMIT = envInt('API_RATE_LIMIT', 300);
const API_RATE_WINDOW_SEC = envInt('API_RATE_WINDOW_SEC', 60);
const apiLimiter = createRateLimiter({
  limit: API_RATE_LIMIT,
  windowMs: API_RATE_WINDOW_SEC * 1000,
});

// Error monitoring + structured request logs (server/observability.ts). No-op
// until SENTRY_DSN is set, so dev/CI/beta are unaffected; when set, unhandled
// errors are forwarded to Sentry. Never captures secrets/PII (scrubbed).
initObservability();

// Document secrets fall back to weak, publicly-known dev defaults when unset —
// server/documents/crypto.ts uses 'dev-insecure-document-key' for encryption at
// rest, and server/documents/signed-url.ts uses 'dev-insecure-signing-key' for
// the download-token HMAC (a known signing key makes download tokens forgeable).
// Both are fine for dev/CI but MUST be set in production, so hard-fail at startup
// rather than silently protecting real client documents with a public key.
if (process.env.NODE_ENV === 'production') {
  const missing = [
    !process.env.EB_DOCUMENT_KEY && 'EB_DOCUMENT_KEY (encryption at rest)',
    !process.env.EB_SIGNING_KEY && 'EB_SIGNING_KEY (download-URL signing)',
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(
      `Refusing to start in production without: ${missing.join(', ')}. ` +
        'Set a 32-byte hex EB_DOCUMENT_KEY and a strong random EB_SIGNING_KEY (docs/14).',
    );
    process.exit(1);
  }
}

// Resolve TLS for the DB connection (server/db-ssl.ts). Supabase's pooler needs
// TLS but presents a cert chaining to Supabase's private CA; this connects
// correctly (full verification when a CA is provided, else encrypted-unverified).
const db = resolveDbConnection(DATABASE_URL);
if (db.tls && !db.verified && process.env.NODE_ENV === 'production') {
  console.warn(
    'WARNING: Postgres TLS is enabled but the server certificate is NOT verified. ' +
      'Set DATABASE_CA_CERT (Supabase dashboard → Database → SSL configuration) to enable full verification.',
  );
}

// connectionTimeoutMillis is essential for the deploy health check: without it,
// a slow/unreachable DB makes a query hang indefinitely (pg has no default
// connect timeout). That is what previously hung /health and made Render time
// the whole deploy out. Bound it so any DB call fails fast instead.
const pool = new pg.Pool({
  connectionString: db.connectionString,
  ssl: db.ssl,
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

// Best-effort client identifier for webhook rate limiting. Behind a trusted
// proxy (Render terminates TLS and sets X-Forwarded-For), the FIRST hop is the
// original client; use it when present, else fall back to the socket address.
// NOTE: X-Forwarded-For is only trustworthy behind a trusted proxy — a direct
// client can spoof it. That is acceptable here because this is not an auth
// boundary (the webhooks are signature/secret-gated); it only bounds volume.
function clientKey(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const header = Array.isArray(xff) ? xff[0] : xff;
  if (header) {
    const first = header.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// Enforce the per-client webhook rate limit. Returns true if the request was
// rejected (a 429 with Retry-After has already been sent) so the caller returns
// immediately. 429 — NOT 503, which in this codebase means "endpoint disabled".
function rateLimited(
  req: IncomingMessage,
  res: ServerResponse,
  limiter: RateLimiter = webhookLimiter,
): boolean {
  const { allowed, retryAfterSec } = limiter.check(clientKey(req));
  if (allowed) return false;
  res.setHeader('retry-after', String(retryAfterSec));
  json(res, 429, { message: 'rate limit exceeded' });
  return true;
}

function setCors(req: IncomingMessage, res: ServerResponse) {
  const requestOrigin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  const origin = resolveCorsOrigin(ALLOWED_ORIGINS, requestOrigin);
  res.setHeader('access-control-allow-origin', origin);
  // When the value is chosen from the request's Origin (not '*'), shared caches
  // must key on Origin so one origin's response isn't served to another.
  if (origin !== '*') res.setHeader('vary', 'Origin');
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

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  setCors(req, res);
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

  // Platform monitoring rails (docs/38). The ExitBlueprint team's cross-tenant,
  // four-domain snapshot (infra/product/business/security), assembled from the
  // service-role-only `analytics` schema. A PLATFORM OPERATIONS route, not a
  // tenant function: it reads across every firm, so it is gated by the platform
  // superadmin allowlist (PLATFORM_SUPERADMIN_IDS — the same cross-tenant gate as
  // the `platform-admin` scope), NEVER a firm role, and runs on the service-role
  // pool (RLS bypass) rather than asUser. Unset allowlist → 403, default-deny.
  if (req.method === 'GET' && url.pathname === '/internal/metrics') {
    const claims = await bearer(req);
    if (!claims) return json(res, 401, { message: 'invalid or missing token' });
    if (!isPlatformSuperadmin(claims.sub)) return json(res, 403, { message: 'platform superadmin required' });
    try {
      // One superadmin-gated, service-role readout: the four-domain platform
      // snapshot plus the moat rails — the verified-financial corpus (moat 2), the
      // calibration-corpus KPIs (docs/40 §4a "the moats are the business plan"), and
      // the versioned DRS-band calibration artifact (docs/09 moat 1, the FICO moat),
      // and the deliverable-quality bench (docs/sellside-ai/02) — platform-quality
      // telemetry, not client data. All read-only over the analytics schema; operator-only.
      const [metrics, corpus, moats, calibration, bench] = await Promise.all([
        withTimeout(platformMetrics(pool), 10_000, 'platform metrics'),
        withTimeout(financialCorpus(pool), 10_000, 'financial corpus'),
        withTimeout(moatMetrics(pool), 10_000, 'moat metrics'),
        withTimeout(readCalibration(pool), 10_000, 'calibration'),
        withTimeout(benchSummary(pool), 10_000, 'bench'),
      ]);
      return json(res, 200, { ...metrics, corpus, moats, calibration, bench });
    } catch (e) {
      captureError(e, { route: '/internal/metrics' });
      return json(res, 500, { message: (e as Error).message });
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
      // Safe serve: NEVER trust the stored/browser mime_type. Recompute a safe
      // content-type from the (sanitized) extension and only let a small trusted
      // set render inline (PDF + raster images, which the browser sandboxes);
      // everything else — HTML, SVG, office docs, unknown types — is served as an
      // opaque octet-stream ATTACHMENT so stored HTML/JS can never execute in our
      // origin (stored-XSS). nosniff stops the browser re-interpreting the type.
      const safeName = sanitizeFilename(d.filename);
      const ext = safeName.includes('.') ? safeName.split('.').pop()!.toLowerCase() : '';
      const INLINE_SAFE: Record<string, string> = {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
      };
      const inlineType = INLINE_SAFE[ext];
      res.statusCode = 200;
      res.setHeader('x-content-type-options', 'nosniff');
      if (inlineType) {
        res.setHeader('content-type', inlineType);
        res.setHeader('content-disposition', `inline; filename="${safeName}"`);
      } else {
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="${safeName}"`);
      }
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
    if (rateLimited(req, res)) return;
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
      captureError(e, { route: '/webhooks/clerk' });
      return json(res, 500, { message: (e as Error).message });
    } finally {
      c.release();
    }
  }

  // Stripe webhook — the one unauthenticated external POST that moves money state
  // (docs/24 §5.2). Signature-verified on the RAW body (never JSON-parsed before
  // verify) and idempotent (billing_events dedupes by stripe_event_id inside
  // applyStripeEvent). Unset secret → 503 (disabled), mirroring the Clerk webhook.
  // 200 on handled/duplicate, 400 only on a bad signature.
  if (req.method === 'POST' && url.pathname === '/webhooks/stripe') {
    if (!stripeConfigured()) return json(res, 503, { message: 'stripe webhook not configured' });
    if (rateLimited(req, res)) return;
    const raw = await readBody(req);
    const sig = req.headers['stripe-signature'];
    const sigHeader = Array.isArray(sig) ? sig[0] : sig;
    let event;
    try {
      event = verifyStripeSignature(raw, sigHeader ?? '', stripeWebhookSecret());
    } catch {
      return json(res, 400, { message: 'invalid webhook signature' });
    }
    const c = await pool.connect();
    try {
      return json(res, 200, { ok: true, ...(await applyStripeEvent(c, event)) });
    } catch (e) {
      captureError(e, { route: '/webhooks/stripe' });
      return json(res, 500, { message: (e as Error).message });
    } finally {
      c.release();
    }
  }

  // Continuous-evaluation webhooks (docs/07 §"IN THE CODE"). An external n8n
  // instance calls these on a schedule; each runs a read-only, cross-firm
  // analyzer with the service role and returns structured items n8n routes into
  // per-firm nudges. Authenticated by a SHARED SECRET (x-webhook-secret vs.
  // WEBHOOK_SECRET), not a user JWT: n8n is a trusted system caller, not an RLS
  // principal — the same trust model as scripts/admin.ts. Unset secret → 503
  // (disabled), mirroring the Clerk webhook. Read-only: never writes a score,
  // never mutates an immutable assessment (CLAUDE.md rules 4 & 5).
  if (req.method === 'POST' && url.pathname.startsWith('/webhooks/scheduled/')) {
    if (!WEBHOOK_SECRET) return json(res, 503, { message: 'scheduled webhooks not configured' });
    if (rateLimited(req, res)) return;
    const provided = req.headers['x-webhook-secret'];
    const secret = Array.isArray(provided) ? provided[0] : provided;
    if (!verifyWebhookSecret(secret, WEBHOOK_SECRET)) {
      return json(res, 401, { message: 'invalid webhook secret' });
    }
    const kind = url.pathname.replace('/webhooks/scheduled/', '');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { message: 'invalid JSON body' });
    }
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
    const c = await pool.connect();
    try {
      if (kind === 'stale-engagements') {
        return json(res, 200, await findStaleEngagements(c, { staleDays: num(body.staleDays) }));
      }
      if (kind === 'stalled-tasks') {
        return json(res, 200, await findStalledTasks(c, { stalledDays: num(body.stalledDays) }));
      }
      if (kind === 'reassessment-due') {
        return json(res, 200, await findReassessmentDue(c, { reassessDays: num(body.reassessDays) }));
      }
      if (kind === 'reassessment-ready') {
        return json(res, 200, await findReassessmentReady(c));
      }
      return json(res, 404, { message: `unknown scheduled webhook: ${kind}` });
    } finally {
      c.release();
    }
  }

  if (req.method === 'POST' && url.pathname.startsWith('/functions/v1/')) {
    // Bound volume per IP BEFORE verifying the token, so a flood of bad/expensive
    // tokens can't burn JWKS-verify CPU or reach the DB pool unthrottled.
    if (rateLimited(req, res, apiLimiter)) return;
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
      captureError(e, { route: 'functions/v1', fn: name });
      return json(res, 500, { message: (e as Error).message });
    } finally {
      service.release();
    }
  }

  return json(res, 404, { message: 'not found' });
}

// A single request must never crash the whole service. If the handler rejects —
// most importantly when the DB is unreachable and `pool.connect()` throws (e.g.
// DATABASE_URL points at Supabase's IPv6-only direct connection, which Render
// can't route: `connect ENETUNREACH`) — Node would otherwise treat it as an
// unhandled rejection and terminate the process, restart-looping the service.
// Catch it here and reply 500 instead, so one bad request (or a DB blip) degrades
// gracefully and Svix/webhook callers simply retry.
const server = createServer((req, res) => {
  const start = Date.now();
  res.on('finish', () => {
    logRequest({
      method: req.method ?? '?',
      path: new URL(req.url ?? '/', 'http://localhost').pathname,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  handleRequest(req, res).catch((err) => {
    captureError(err, { route: 'top-level' });
    if (!res.headersSent) json(res, 500, { message: (err as Error).message });
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`functions service listening on :${PORT} (serving /functions/v1/*)`);
});
