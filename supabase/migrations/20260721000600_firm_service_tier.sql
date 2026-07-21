-- Firm service tier: the named service level a firm picks for its exit-readiness
-- practice during first-run onboarding (Essentials / Standard / Premium). It is a
-- firm-level scope/positioning choice the advisor makes when setting up the
-- workspace — deliberately distinct from the Stripe billing plan (which is money;
-- see 20260719000200_billing.sql) and from the computed DRS readiness tiers (which
-- scoring derives, never a user). Additive only; one row per firm.
--
-- RLS follows the firm-settings shape: any firm member READS (so client-facing
-- surfaces can render it later), and firm STAFF who run onboarding (advisor or
-- admin) WRITE. Unlike firm_branding (admin-only write, an org-identity asset),
-- the tier is chosen inside the advisor's first-run checklist, so advisors write.

create table firm_service_tier (
  firm_id uuid primary key references firms (id),
  tier text not null,
  selected_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint firm_service_tier_code
    check (tier in ('essentials', 'standard', 'premium'))
);

create trigger firm_service_tier_touch
  before update on firm_service_tier
  for each row execute function app.touch_updated_at();

grant select, insert, update, delete on firm_service_tier to authenticated;
grant all on firm_service_tier to service_role;

alter table firm_service_tier enable row level security;

-- Any authenticated member of the firm may read their firm's tier.
create policy firm_service_tier_read on firm_service_tier for select to authenticated
  using (firm_id = app.user_firm_id());

-- Onboarding staff (advisor or admin) write their own firm's tier.
create policy firm_service_tier_staff_write on firm_service_tier for all to authenticated
  using (app.user_role() = any (array['advisor', 'admin']::app_role[]) and firm_id = app.user_firm_id())
  with check (app.user_role() = any (array['advisor', 'admin']::app_role[]) and firm_id = app.user_firm_id());
