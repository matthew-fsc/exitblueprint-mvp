-- Beta comp path (docs/25). A firm can be granted full access without a paid
-- Stripe subscription — this is how a beta test group gets in. The entitlement
-- resolver treats comp = entitled, so the (flag-gated) feature gate never blocks
-- a comped firm even before any Stripe wiring exists.
alter table firm_subscriptions add column if not exists comp boolean not null default false;

-- A comped firm may have no Stripe subscription at all, so allow a bare row that
-- only carries comp + plan_code. (status defaults to 'incomplete'; comp overrides.)
comment on column firm_subscriptions.comp is
  'True = firm is comped (beta / internal): fully entitled regardless of Stripe status.';
