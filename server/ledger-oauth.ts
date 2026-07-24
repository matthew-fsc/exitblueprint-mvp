// Ledger connection lifecycle over real OAuth 2.0 (QuickBooks / Xero), with a
// dev simulation when no live app is registered.
//
//   begin    → persist a pending state, hand back the provider authorize URL
//   complete → exchange the returned code for tokens, record the connection
//   disconnect → revoke the token, flip the connection to 'disconnected'
//
// Tokens live in ledger_credentials (service-only, never client-readable); the
// client-readable ledger_connections row only carries status/org/realm for the
// UI. Both owner and advisor surfaces drive the exact same three functions, so
// the workflow is identical on either side.
//
// `db` here is a service connection (edge function / service_role), so it can
// read and write the quarantined credential tables.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export type LedgerProvider = 'quickbooks' | 'xero';

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string | null;
  scope: string;
}

// Live provider credentials from the environment; null means "not configured",
// which routes the flow through the dev simulation. Swapping in a real Intuit /
// Xero app is purely a matter of setting these env vars — no code change.
export function providerConfig(provider: LedgerProvider): ProviderConfig | null {
  const env = process.env;
  const redirectUri = env.LEDGER_OAUTH_REDIRECT_URI; // e.g. https://app.example.com/ledger/callback
  if (!redirectUri) return null;
  if (provider === 'quickbooks') {
    if (!env.QUICKBOOKS_CLIENT_ID || !env.QUICKBOOKS_CLIENT_SECRET) return null;
    return {
      clientId: env.QUICKBOOKS_CLIENT_ID,
      clientSecret: env.QUICKBOOKS_CLIENT_SECRET,
      redirectUri,
      authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
      tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      revokeUrl: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
      scope: 'com.intuit.quickbooks.accounting',
    };
  }
  if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) return null;
  return {
    clientId: env.XERO_CLIENT_ID,
    clientSecret: env.XERO_CLIENT_SECRET,
    redirectUri,
    authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    revokeUrl: 'https://identity.xero.com/connect/revocation',
    scope: 'accounting.transactions accounting.reports.read offline_access',
  };
}

function providerLabel(p: LedgerProvider): string {
  return p === 'quickbooks' ? 'QuickBooks' : 'Xero';
}

// The dev simulation (no live provider app configured) synthesizes fake tokens and
// a fully-real-shaped 'connected' record so the flow can be exercised locally. That
// is a lie about reality and must NEVER run in production: a prod deploy with an
// unconfigured provider should fail loudly, not fabricate a connection that later
// yields zero financials. Guard the two entry points that would otherwise fall
// through to the simulation when providerConfig() returns null.
function assertLiveProviderInProd(provider: LedgerProvider): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${providerLabel(provider)} is not configured for this environment. ` +
        'Set the provider OAuth credentials before connecting a ledger in production.',
    );
  }
}

export interface BeginResult {
  mode: 'oauth' | 'dev';
  provider: LedgerProvider;
  state: string;
  authorize_url: string | null; // present in 'oauth' mode; the browser navigates here
}

// Step 1: record the pending request and produce the authorize URL. In dev mode
// there is no external provider, so the client calls complete() straight away
// with the returned state.
export async function beginLedgerConnect(
  db: pg.ClientBase,
  args: { companyId: string; provider: LedgerProvider; connectedBy?: string | null; returnTo?: string | null },
): Promise<BeginResult> {
  const company = (
    await db.query(`select firm_id from companies where id = $1`, [args.companyId])
  ).rows[0];
  if (!company) throw new Error('company not found');

  const state = randomBytes(24).toString('hex');
  await db.query(
    `insert into ledger_oauth_states (state, firm_id, company_id, provider, connected_by, return_to)
     values ($1, $2, $3, $4, $5, $6)`,
    [state, company.firm_id, args.companyId, args.provider, args.connectedBy ?? null, args.returnTo ?? null],
  );

  const cfg = providerConfig(args.provider);
  if (!cfg) {
    assertLiveProviderInProd(args.provider);
    return { mode: 'dev', provider: args.provider, state, authorize_url: null };
  }

  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('state', state);
  return { mode: 'oauth', provider: args.provider, state, authorize_url: url.toString() };
}

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

async function exchangeCode(cfg: ProviderConfig, code: string): Promise<Tokens> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
  };
}

export interface CompleteResult {
  connection_id: string;
  provider: LedgerProvider;
  status: 'connected';
  org_name: string | null;
  return_to: string | null;
}

// Step 2: consume the pending state and record the connection. Real mode
// exchanges the code for tokens; dev mode synthesizes them so the flow completes
// without a live provider. Either way the tokens land in ledger_credentials and
// the client-readable connection flips to 'connected'.
export async function completeLedgerConnect(
  db: pg.ClientBase,
  args: { state: string; code?: string | null; realmId?: string | null },
): Promise<CompleteResult> {
  const pending = (
    await db.query(
      `delete from ledger_oauth_states where state = $1
       returning firm_id, company_id, provider, connected_by, return_to`,
      [args.state],
    )
  ).rows[0];
  if (!pending) throw new Error('invalid or expired connect request');

  const provider = pending.provider as LedgerProvider;
  const cfg = providerConfig(provider);
  const orgName =
    (await db.query(`select name from companies where id = $1`, [pending.company_id])).rows[0]?.name ?? null;

  let tokens: Tokens;
  let realmId: string | null;
  if (cfg) {
    if (!args.code) throw new Error('missing authorization code from provider');
    tokens = await exchangeCode(cfg, args.code);
    realmId = args.realmId ?? null;
  } else {
    // Dev simulation: no external handshake, but a fully real-shaped record.
    // Never in production — a prod deploy must have a real provider configured.
    assertLiveProviderInProd(provider);
    tokens = {
      accessToken: `dev-access-${randomBytes(8).toString('hex')}`,
      refreshToken: `dev-refresh-${randomBytes(8).toString('hex')}`,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    };
    realmId = `dev-realm-${randomBytes(4).toString('hex')}`;
  }

  const conn = (
    await db.query(
      `insert into ledger_connections
         (firm_id, company_id, provider, status, external_org_name, connected_at, realm_id, connected_by, disconnected_at)
       values ($1, $2, $3, 'connected', $4, now(), $5, $6, null)
       on conflict (company_id, provider) do update set
         status = 'connected', external_org_name = excluded.external_org_name,
         connected_at = now(), realm_id = excluded.realm_id,
         connected_by = excluded.connected_by, disconnected_at = null
       returning id`,
      [pending.firm_id, pending.company_id, provider, orgName, realmId, pending.connected_by],
    )
  ).rows[0];

  await db.query(
    `insert into ledger_credentials (connection_id, access_token, refresh_token, token_expires_at, realm_id)
     values ($1, $2, $3, $4, $5)
     on conflict (connection_id) do update set
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at, realm_id = excluded.realm_id,
       updated_at = now()`,
    [conn.id, tokens.accessToken, tokens.refreshToken, tokens.expiresAt, realmId],
  );

  return {
    connection_id: conn.id,
    provider,
    status: 'connected',
    org_name: orgName,
    return_to: pending.return_to ?? null,
  };
}

async function revokeToken(cfg: ProviderConfig, token: string): Promise<void> {
  if (!cfg.revokeUrl) return;
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  await fetch(cfg.revokeUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token }),
  });
}

export interface DisconnectResult {
  connection_id: string;
  provider: LedgerProvider;
  status: 'disconnected';
}

// Step 3: revoke the token (best-effort) and turn the connection off. The row is
// kept — status becomes 'disconnected' and the secrets are wiped — so history
// (when it was connected, by whom) survives a disconnect/reconnect cycle.
export async function disconnectLedger(
  db: pg.ClientBase,
  args: { connectionId: string },
): Promise<DisconnectResult> {
  const conn = (
    await db.query(`select id, provider from ledger_connections where id = $1`, [args.connectionId])
  ).rows[0];
  if (!conn) throw new Error('connection not found');

  const provider = conn.provider as LedgerProvider;
  const cfg = providerConfig(provider);
  const creds = (
    await db.query(
      `select refresh_token, access_token from ledger_credentials where connection_id = $1`,
      [args.connectionId],
    )
  ).rows[0];

  if (cfg && creds) {
    // Best-effort: a failed revoke must not block the user from disconnecting.
    try {
      await revokeToken(cfg, creds.refresh_token ?? creds.access_token);
    } catch {
      /* swallow — we still drop our copy of the token below */
    }
  }

  await db.query(`delete from ledger_credentials where connection_id = $1`, [args.connectionId]);
  await db.query(
    `update ledger_connections set status = 'disconnected', disconnected_at = now(), realm_id = null
     where id = $1`,
    [args.connectionId],
  );

  return { connection_id: args.connectionId, provider, status: 'disconnected' };
}
