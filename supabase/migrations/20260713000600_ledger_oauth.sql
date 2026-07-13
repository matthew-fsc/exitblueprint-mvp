-- Real ledger OAuth: connecting QuickBooks/Xero through the provider's OAuth 2.0
-- handshake. "Begin" hands back the provider authorize URL; the provider
-- redirects to our callback with an authorization code; the server exchanges the
-- code for access/refresh tokens. Disconnect revokes the token and flips the
-- connection to 'disconnected' (the row is kept for history, never deleted).
--
-- Tokens are secrets, so they live in ledger_credentials — which has NO grant to
-- the `authenticated` role. A client JWT can therefore never read a token, RLS
-- or not; only service_role (edge functions) touches this table. Meanwhile
-- ledger_connections stays client-readable (status, org name, realm) so the UI
-- can show connection state — the secret material is quarantined here.
--
-- When provider credentials are not configured (dev, or before a live app is
-- registered) the server simulates the handshake so the whole connect / sync /
-- disconnect flow still works end-to-end. See server/ledger-oauth.ts.

-- Realm/tenant id from the provider (QuickBooks companyId, Xero tenantId), and
-- when a connection was turned off (kept for history, not deleted).
alter table ledger_connections add column realm_id text;
alter table ledger_connections add column disconnected_at timestamptz;

-- Pending authorization requests: created at "begin", consumed at the callback.
-- Carries the CSRF state and where to send the user back afterwards. Service-only.
create table ledger_oauth_states (
  state text primary key,
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  company_id uuid not null references companies (id),
  provider ledger_provider not null,
  connected_by uuid references profiles (id),
  return_to text
);

-- OAuth tokens for a connection: one row per connection. Service-only — the
-- absence of any grant to authenticated is the whole point (no token ever
-- reaches a browser). Cascades away if the connection row is deleted.
create table ledger_credentials (
  connection_id uuid primary key references ledger_connections (id) on delete cascade,
  updated_at timestamptz not null default now(),
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz,
  realm_id text
);

create index on ledger_oauth_states (company_id);

-- Only service_role. Deliberately NO grants to `authenticated`.
grant all on ledger_oauth_states to service_role;
grant all on ledger_credentials to service_role;

alter table ledger_oauth_states enable row level security;
alter table ledger_credentials enable row level security;
-- No policies on purpose: RLS enabled with no policy denies every authenticated
-- read, and with no table grant even a bare select errors. service_role bypasses
-- RLS, so the edge functions retain full access.
