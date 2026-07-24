-- Market-intelligence reference data (docs/sellside-ai/01-market-intelligence-rag.md,
-- build order step 1: "structured multiples only, deterministic lane"). Licensed
-- third-party market multiples (sector median/spread by industry × size band) that
-- can INFORM the valuation base multiple the same way ownBookMultiple already does:
-- only when a NEW valuation_rules_version elects it, never via an LLM (CLAUDE.md §1).
--
-- NON-TENANT REFERENCE DATA — THE EXPLICIT RULE-#5 EXCEPTION. This is GLOBAL
-- LICENSED REFERENCE DATA, not any firm's tenant data, so — unlike every domain
-- table — it deliberately carries NO firm_id and sits under NO firm-scoped RLS.
-- CLAUDE.md §5 governs firm isolation of TENANT data; reference data is the
-- documented non-tenant case (docs/sellside-ai/01 "Data model"). It parallels the
-- service-role-only `analytics` schema, but the opposite direction: analytics is a
-- cross-firm rollup locked to service_role; `market` is bought reference data that
-- authenticated roles may READ. Any per-license/per-firm exposure limit (aggregate
-- vs. row-level vs. third-party display, freshness, AI-ingestion) is enforced at the
-- RETRIEVAL / EXPOSURE layer that reads these tables — NOT by RLS here, because
-- there is no firm to isolate on. This schema is NOT added to any PostgREST
-- exposed-schema list; it is reached only through the server (server/comparables.ts
-- marketMultiple), never a direct client query.
--
-- LICENSE TERMS AS ENFORCED FLAGS (docs/sellside-ai/01 "IP & licensing"): a paid
-- dataset has terms, so `market.datasets` encodes what the license permits as
-- COLUMNS the retrieval layer filters on — display scope, AI-ingestion, derivative
-- rights, purge-on-termination — rather than relying on reviewer memory (same
-- posture as server/financial-corpus.ts's counts-only note).

create schema if not exists market;

-- No PUBLIC access; grants below are explicit. authenticated may READ (reference
-- data), service_role has full access (out-of-band ingestion writes these).
revoke all on schema market from public;

-- ── Datasets (one row per licensed source + its license terms + version) ─────────
-- `as_of` gates data currency; the display/ingestion/derivative/purge flags encode
-- the contract so a dataset licensed for internal aggregate use only can never be
-- surfaced row-level or fed to an LLM by the retrieval layer.
create table market.datasets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  vendor text not null,
  -- License-exposure terms, enforced as columns (not reviewer memory):
  display_scope text not null default 'aggregate_only'
    check (display_scope in ('aggregate_only', 'row_level', 'third_party_display')),
  ai_ingestion_allowed boolean not null default false,
  derivative_rights boolean not null default false,
  purge_on_termination boolean not null default true,
  as_of date not null
);

-- ── Multiples (sector × size band → distribution) ────────────────────────────────
-- Normalized at ingestion to the SAME key-space server/valuation.ts uses
-- (industryKeyFor + size_band; mirrored purely in shared/market-keys.ts) so a market
-- multiple lines up with the seeded table multiple and the firm's own-book multiple.
create table market.multiples (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  dataset_id uuid not null references market.datasets (id),
  industry_key text not null,
  size_band text not null,
  median_multiple numeric not null,
  p25_multiple numeric,
  p75_multiple numeric,
  sample_size integer not null default 0,
  as_of date not null,
  unique (dataset_id, industry_key, size_band)
);
create index on market.multiples (industry_key, size_band);

-- Grants: authenticated READS reference data; service_role has full access for the
-- out-of-band ingestion pipeline. NO firm-scoped RLS — there is no firm_id to
-- isolate on; exposure limits live in the retrieval layer (see the header comment).
grant usage on schema market to authenticated, service_role;
grant select on all tables in schema market to authenticated;
grant all on all tables in schema market to service_role;

-- DoD: `npm run db:migrate` on a fresh DB; the `market` schema is non-tenant and
-- readable, tenant tables unchanged (scripts/rls-test.ts asserts the non-tenant
-- posture); valuation fixtures still reproduce exactly (market_multiples config is
-- disabled by default, so the numeric output is byte-identical — CLAUDE.md §1).
