-- Redeemable comp codes — the paywall's complimentary-access path, made self-serve
-- (docs/24 §5.7). BILLING_ENFORCED can be turned on (the GA paywall) while pilot /
-- design-partner firms are handed a short access code that grants complimentary
-- access WITHOUT Stripe. Redeeming a code sets the firm's subscription comp = true
-- (shared/entitlements: comp overrides Stripe status = fully entitled), so a
-- paywalled build still lets a comped firm through the entitlement gate.
--
-- Codes are SECRETS: possession of a valid code grants access. So both tables are
-- service-role only (no grant to authenticated, RLS deny-by-default). Redemption
-- runs through the redeem-comp-code function under the service role, which resolves
-- the firm from the caller's own profile (never the request body). This mirrors the
-- billing_events posture: no authenticated read, ever.

-- The code catalog. `code` is stored normalized (trim + upper-case) so lookups are
-- exact. plan_code (optional) attaches a plan on redeem; NULL = bare comp (full
-- access, no plan-feature restriction). max_redemptions NULL = unlimited.
create table comp_codes (
  code text primary key,
  label text not null,                          -- operator note: which cohort / partner this batch is for
  plan_code text references plans (code),        -- plan to attach on redeem (NULL = bare comp = full access)
  max_redemptions int,                           -- max distinct firms that may redeem (NULL = unlimited)
  redeemed_count int not null default 0,
  expires_at timestamptz,                         -- NULL = never expires
  active boolean not null default true,
  created_by text,                               -- Clerk user id of the operator who minted it (nullable: CLI/seed)
  created_at timestamptz not null default now()
);

-- One row per (code, firm) redemption. The unique constraint makes a firm
-- redeeming the same code twice idempotent — it never consumes a second slot.
create table comp_code_redemptions (
  id uuid primary key default gen_random_uuid(),
  code text not null references comp_codes (code) on delete cascade,
  firm_id uuid not null references firms (id) on delete cascade,
  redeemed_by text,                              -- Clerk user id of the advisor who redeemed
  redeemed_at timestamptz not null default now(),
  unique (code, firm_id)
);
create index on comp_code_redemptions (firm_id);

-- Grants + RLS: both tables are service-role only. A code is a credential; a read
-- grant to authenticated would leak valid codes. RLS on with no authenticated
-- policy = deny-by-default (same posture as billing_events).
grant all on comp_codes to service_role;
grant all on comp_code_redemptions to service_role;

alter table comp_codes enable row level security;
alter table comp_code_redemptions enable row level security;
-- (no authenticated grant, no authenticated policy — a tenant read is a hard
--  permission error, verified in scripts/rls-test.ts.)
