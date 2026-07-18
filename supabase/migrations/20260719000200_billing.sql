-- Stripe billing — per-firm subscription + seats (docs/24, decision 2026-07-18).
-- The advisor firm is the paying customer: firm = Stripe Customer = Clerk Org.
-- Stripe is the source of truth for money; these tables are the cache the app
-- reads. All writes happen server-side (checkout + signature-verified webhooks
-- under the service role); no client ever writes billing state.

-- Plan catalog. stripe_price_id is filled once the Stripe Product/Price exists
-- (dollar amounts live in Stripe, not here). seat_limit / engagement_limit NULL
-- = unlimited. features is the capability set the entitlement gate reads.
create table plans (
  code text primary key,               -- 'solo' | 'practice' | 'firm'
  name text not null,
  stripe_price_id text,                -- set when the Stripe Price is created
  seat_limit int,                      -- max advisor seats (NULL = unlimited)
  engagement_limit int,                -- max active engagements (NULL = unlimited)
  features jsonb not null default '[]', -- enabled capability keys
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Firm's link to its Stripe Customer.
alter table firms add column if not exists stripe_customer_id text unique;

-- One subscription row per firm — the cached reflection of Stripe state.
create table firm_subscriptions (
  firm_id uuid primary key references firms (id) on delete cascade,
  stripe_subscription_id text unique,
  plan_code text references plans (code),
  status text not null default 'incomplete',   -- trialing|active|past_due|canceled|incomplete
  seats int not null default 1,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index on firm_subscriptions (status);

-- Idempotent webhook log: every Stripe event is recorded here first, keyed by
-- its Stripe event id, so a redelivered event is a no-op.
create table billing_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  type text not null,
  payload jsonb not null default '{}',
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index on billing_events (type, received_at desc);

-- Grants + RLS.
--   plans: a read-only catalog for any authenticated user (like methodology_read).
--   firm_subscriptions: staff read their OWN firm's row; never client-writable.
--   billing_events: service-role only — no authenticated access at all.
grant select on plans to authenticated;
grant all on plans to service_role;
grant select on firm_subscriptions to authenticated;
grant all on firm_subscriptions to service_role;
grant all on billing_events to service_role;

alter table plans enable row level security;
alter table firm_subscriptions enable row level security;
alter table billing_events enable row level security;

create policy plans_read on plans for select to authenticated using (active);

create policy firm_subscription_read on firm_subscriptions for select to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());

-- billing_events: deny-by-default (RLS on, no authenticated policy, no grant).

-- Seed the three tiers (Combo B, approved 2026-07-18). Prices are set in Stripe
-- later; the shape (tiers, seats, engagement limits, feature split) is what the
-- app builds against. Idempotent so re-running migrations/seeds is safe.
insert into plans (code, name, seat_limit, engagement_limit, features, sort) values
  ('solo', 'Solo', 1, 5,
   '["assessment","roadmap","owner_portal"]'::jsonb, 1),
  ('practice', 'Practice', 5, 25,
   '["assessment","roadmap","owner_portal","valuation","buyer_lens","data_room","documents","verification","delta_report"]'::jsonb, 2),
  ('firm', 'Firm', null, null,
   '["assessment","roadmap","owner_portal","valuation","buyer_lens","data_room","documents","verification","delta_report","branding","priority_support"]'::jsonb, 3)
on conflict (code) do update set
  name = excluded.name,
  seat_limit = excluded.seat_limit,
  engagement_limit = excluded.engagement_limit,
  features = excluded.features,
  sort = excluded.sort;
