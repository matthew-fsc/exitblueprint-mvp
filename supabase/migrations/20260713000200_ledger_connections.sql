-- Owner portal: accounting (ledger) connections. Models an owner connecting
-- their QuickBooks/Xero to the engagement. The real OAuth handshake is external;
-- this table records the connection state that the connect flow writes and the
-- verification layer reads (a connected ledger is what promotes financial inputs
-- from self-reported to ledger-verified).
--
-- The owner controls their own books connection, so — unusually for owner rows —
-- they get write access, scoped to their own company.

create type ledger_provider as enum ('quickbooks', 'xero');
create type ledger_status as enum ('disconnected', 'connected', 'error');

create table ledger_connections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  company_id uuid not null references companies (id),
  provider ledger_provider not null,
  status ledger_status not null default 'connected',
  external_org_name text,          -- the accounting file's org name, once connected
  connected_at timestamptz,
  last_sync_at timestamptz,
  connected_by uuid references profiles (id),
  unique (company_id, provider)
);

create index on ledger_connections (firm_id);
create index on ledger_connections (company_id);

grant select, insert, update, delete on ledger_connections to authenticated;
grant all on ledger_connections to service_role;

alter table ledger_connections enable row level security;

-- Advisor: full CRUD within their firm.
create policy advisor_firm_all on ledger_connections for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

-- Owner: manage their own company's connections (connect / disconnect).
create policy owner_company_all on ledger_connections for all to authenticated
  using (app.user_role() = 'owner' and company_id = app.user_company_id())
  with check (app.user_role() = 'owner' and company_id = app.user_company_id());
