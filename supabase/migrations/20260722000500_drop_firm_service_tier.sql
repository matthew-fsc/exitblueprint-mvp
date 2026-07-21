-- Drop firm_service_tier: the first-run "service tier" (Essentials / Standard /
-- Premium) a firm picked during onboarding. It was a separate positioning choice
-- that never converged with — and did not match — the Stripe billing plans
-- (Solo / Practice / Firm; see 20260719000200_billing.sql) shown under Settings →
-- Manage billing, which confused the two catalogs. Plan selection now lives solely
-- in billing, so the onboarding tier step and this table are removed. No other
-- table references it; dropping cascades its RLS policies and touch trigger.
drop table if exists firm_service_tier;
