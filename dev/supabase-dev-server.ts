// Dev-only Supabase emulator (Vite middleware), the runtime sibling of
// db/supabase-shim.sql: lets the untouched supabase-js app code run against a
// plain local Postgres when the real Supabase stack (Docker) is unavailable.
// It implements ONLY the surface this app uses:
//   POST /auth/v1/token (password + refresh_token grants), GET /auth/v1/user,
//   POST /auth/v1/logout
//   /rest/v1/<table>  — GET (eq/in/order/limit), POST (insert/upsert), PATCH
//   POST /functions/v1/<name> — the server functions in /server
// Every /rest request runs as role `authenticated` with the caller's JWT
// claims applied, so the REAL RLS policies are enforced, same as PostgREST.
// DEV AUTH: any existing auth.users email with the fixed password 'demo'.
// Never deploy this file; production uses the real Supabase stack.
import type { Connect, Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { handleFunctionCall } from '../server/functions';
import { verifyDocumentToken } from '../server/documents/signed-url';
import { getDocumentBytes } from '../server/documents/pipeline';
import { logAccess } from '../server/audit';

const DEV_JWT_SECRET = 'exit-blueprint-dev-secret';
const DEV_PASSWORD = 'demo';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

const IDENT = /^[a-z_][a-z0-9_]*$/;

interface Claims {
  sub: string;
  email: string;
  role: 'authenticated';
  exp: number;
  [key: string]: unknown;
}

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function signJwt(payload: object): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', DEV_JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function verifyJwt(token: string): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', DEV_JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Claims;
  if (claims.exp < Date.now() / 1000) return null;
  return claims;
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function supabaseDevServer(): Plugin {
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55499/exit_blueprint',
    max: 5,
  });

  // Runs fn on a connection with role `authenticated` + the caller's claims,
  // inside a transaction, so all RLS policies apply exactly as in PostgREST.
  async function asUser<T>(claims: Claims, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);
      await client.query('set local role authenticated');
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function sessionFor(userId: string, email: string) {
    const claims: Claims = {
      sub: userId,
      email,
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    };
    return {
      access_token: signJwt(claims),
      token_type: 'bearer',
      expires_in: TOKEN_TTL_SECONDS,
      expires_at: claims.exp,
      refresh_token: `dev-refresh.${userId}.${b64url(email)}`,
      user: { id: userId, email, aud: 'authenticated', role: 'authenticated' },
    };
  }

  async function handleAuth(req: Connect.IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      const body = JSON.parse((await readBody(req)) || '{}');
      if (grant === 'password') {
        const user = await pool.query(`select id, email from auth.users where email = $1`, [
          body.email,
        ]);
        if (user.rowCount === 0 || body.password !== DEV_PASSWORD) {
          return json(res, 400, {
            error: 'invalid_grant',
            error_description: `Invalid login (dev stack: any provisioned email with password '${DEV_PASSWORD}')`,
          });
        }
        return json(res, 200, await sessionFor(user.rows[0].id, user.rows[0].email));
      }
      if (grant === 'refresh_token') {
        const [tag, userId] = String(body.refresh_token ?? '').split('.');
        if (tag !== 'dev-refresh' || !userId) return json(res, 400, { error: 'invalid_grant' });
        const user = await pool.query(`select id, email from auth.users where id = $1`, [userId]);
        if (user.rowCount === 0) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, await sessionFor(user.rows[0].id, user.rows[0].email));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
      const claims = bearerClaims(req);
      if (!claims) return json(res, 401, { message: 'invalid token' });
      return json(res, 200, {
        id: claims.sub,
        email: claims.email,
        aud: 'authenticated',
        role: 'authenticated',
      });
    }
    if (req.method === 'POST' && url.pathname === '/auth/v1/logout') {
      res.statusCode = 204;
      return res.end();
    }
    return json(res, 404, { message: `dev auth: unsupported ${req.method} ${url.pathname}` });
  }

  function bearerClaims(req: Connect.IncomingMessage): Claims | null {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    return verifyJwt(auth.slice(7));
  }

  function parseFilters(url: URL): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [key, raw] of url.searchParams.entries()) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
      if (!IDENT.test(key)) throw new Error(`bad filter column '${key}'`);
      if (raw.startsWith('eq.')) {
        params.push(raw.slice(3));
        clauses.push(`${key} = $${params.length}`);
      } else if (raw.startsWith('in.(') && raw.endsWith(')')) {
        params.push(raw.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')));
        clauses.push(`${key} = any($${params.length})`);
      } else if (raw.startsWith('is.null')) {
        clauses.push(`${key} is null`);
      } else {
        throw new Error(`dev rest: unsupported filter '${key}=${raw}'`);
      }
    }
    return { sql: clauses.length ? ` where ${clauses.join(' and ')}` : '', params };
  }

  async function handleRest(req: Connect.IncomingMessage, res: ServerResponse, url: URL) {
    const claims = bearerClaims(req);
    if (!claims) return json(res, 401, { message: 'JWT required (dev stack: log in first)' });
    const table = url.pathname.replace('/rest/v1/', '');
    if (!IDENT.test(table)) return json(res, 400, { message: `bad table '${table}'` });

    const wantsSingle = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
    const prefer = String(req.headers.prefer ?? '');

    try {
      const rows = await asUser(claims, async (c) => {
        if (req.method === 'GET') {
          const { sql, params } = parseFilters(url);
          let query = `select * from ${table}${sql}`;
          const order = url.searchParams.get('order');
          if (order) {
            const [col, dir] = order.split('.');
            if (!IDENT.test(col)) throw new Error(`bad order column`);
            query += ` order by ${col} ${dir === 'desc' ? 'desc' : 'asc'}`;
          }
          const limit = url.searchParams.get('limit');
          if (limit && /^\d+$/.test(limit)) query += ` limit ${limit}`;
          return (await c.query(query, params)).rows;
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || 'null');
          const records = Array.isArray(body) ? body : [body];
          if (records.length === 0) return [];
          const cols = Object.keys(records[0]);
          if (!cols.length || cols.some((k) => !IDENT.test(k))) throw new Error('bad insert columns');
          const colList = cols.join(', ');
          let query = `insert into ${table} (${colList})
                       select ${colList} from jsonb_populate_recordset(null::${table}, $1)`;
          const onConflict = url.searchParams.get('on_conflict');
          if (prefer.includes('resolution=merge-duplicates') && onConflict) {
            const conflictCols = onConflict.split(',');
            if (conflictCols.some((k) => !IDENT.test(k))) throw new Error('bad conflict columns');
            const updates = cols
              .filter((k) => !conflictCols.includes(k))
              .map((k) => `${k} = excluded.${k}`);
            query += ` on conflict (${onConflict}) do update set ${updates.join(', ')}`;
          }
          query += ' returning *';
          return (await c.query(query, [JSON.stringify(records)])).rows;
        }
        if (req.method === 'PATCH') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const { sql, params } = parseFilters(url);
          if (!sql) throw new Error('dev rest: PATCH requires a filter');
          const sets: string[] = [];
          for (const [key, value] of Object.entries(body)) {
            if (!IDENT.test(key)) throw new Error('bad update column');
            params.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
            sets.push(`${key} = $${params.length}`);
          }
          return (
            await c.query(`update ${table} set ${sets.join(', ')}${sql} returning *`, params)
          ).rows;
        }
        throw new Error(`dev rest: unsupported method ${req.method}`);
      });

      if (wantsSingle) {
        if (rows.length !== 1) {
          return json(res, 406, { message: `expected a single row, got ${rows.length}` });
        }
        return json(res, 200, rows[0]);
      }
      return json(res, req.method === 'POST' ? 201 : 200, rows);
    } catch (err) {
      return json(res, 400, { message: (err as Error).message });
    }
  }

  // Short-expiry signed document download (R5) — mirrors server/http.ts. No JWT;
  // the HMAC token authorizes exactly one document until it expires.
  async function handleDocumentDownload(_req: Connect.IncomingMessage, res: ServerResponse, url: URL) {
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

  async function handleFunctions(req: Connect.IncomingMessage, res: ServerResponse, url: URL) {
    const claims = bearerClaims(req);
    if (!claims) return json(res, 401, { message: 'JWT required' });
    const name = url.pathname.replace('/functions/v1/', '');
    const body = JSON.parse((await readBody(req)) || '{}');

    // Thin transport adapter over the portable router (server/functions.ts): a
    // service-role connection for the privileged work, and asUser bound to the
    // caller's claims so RLS applies exactly as in PostgREST. A production host
    // mounts the same handleFunctionCall the same way.
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
    } finally {
      service.release();
    }
  }

  return {
    name: 'supabase-dev-server',
    apply: 'serve',
    configureServer(server) {
      console.log(
        `  supabase-dev-server: emulating auth/rest/functions against local Postgres (DEV password: '${DEV_PASSWORD}')`,
      );
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = url.pathname.startsWith('/auth/v1/')
          ? handleAuth
          : url.pathname.startsWith('/rest/v1/')
            ? handleRest
            : url.pathname.startsWith('/functions/v1/')
              ? handleFunctions
              : url.pathname === '/documents/download'
                ? handleDocumentDownload
                : null;
        if (!route) return next();
        route(req, res, url).catch((err) => json(res, 500, { message: String(err) }));
      });
    },
  };
}
