-- Market-intelligence retrieval passages (docs/sellside-ai/01-market-intelligence-rag.md,
-- build order step 2: "Retrieval + citation contract"). Short, cited text chunks —
-- sector commentary, precedent-transaction notes, multiple notes — that GROUND the
-- narrative documents (buyer lens, CIM, diligence sim, valuation commentary). The
-- reasoning lane may QUOTE a retrieved figure, but only if it was actually retrieved
-- and it carries a citation (CLAUDE.md §2 — AI is narrative-only; the passage text is
-- an INPUT to a payload, never a path into a score).
--
-- STRUCTURED + FULL-TEXT RETRIEVAL FIRST; pgvector is deferred. docs/01 sketches
-- semantic embeddings over market.passages via pgvector, but CI runs stock
-- postgres:16 WITHOUT the vector extension, so this lane ships as deterministic
-- STRUCTURED filtering (industry_key × size_band × license exposure) + Postgres
-- FULL-TEXT SEARCH (a generated tsvector + GIN index). Semantic embeddings are a
-- documented follow-on that adds a vector column + an ANN index behind the same
-- retrieveMarketContext() seam — no consumer changes when it lands.
--
-- NON-TENANT REFERENCE DATA — THE EXPLICIT RULE-#5 EXCEPTION, exactly like
-- market.multiples (20260724013906_market_reference_schema.sql): global licensed
-- reference data carries NO firm_id and sits under NO firm-scoped RLS, because there
-- is no firm to isolate on. Any per-license exposure limit (aggregate vs. row-level
-- vs. third-party display, freshness) is enforced at the RETRIEVAL layer
-- (server/market-retrieval.ts) that reads this table — NOT by RLS here. This schema
-- is NOT on any PostgREST exposed-schema list; it is reached only through the server.

-- ── Passages (retrievable, cited text chunks) ────────────────────────────────────
-- Normalized to the SAME key-space as market.multiples / valuation (industry_key +
-- size_band; see shared/market-keys.ts) so a passage lines up with the sector's
-- multiple. `cite_id`/`citation` carry the source-contract tokens the citation
-- firewall renders (docs/01 "citation contract"); `as_of` gates data currency.
create table market.passages (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references market.datasets (id),
  industry_key text not null,
  size_band text,
  kind text not null, -- e.g. 'sector_commentary', 'precedent_transaction', 'multiple_note'
  body text not null,
  cite_id text not null,
  citation text not null,
  as_of date,
  created_at timestamptz not null default now(),
  -- Full-text search vector over the passage body (stock postgres:16, no extension).
  -- Generated + stored so retrieval ranks with ts_rank/websearch_to_tsquery without
  -- recomputing per query; the deferred pgvector lane would add a sibling column.
  search_tsv tsvector generated always as (to_tsvector('english', coalesce(body, ''))) stored,
  -- Natural key the seed upserts on (idempotent re-seed): a cite_id is unique within
  -- a dataset.
  unique (dataset_id, cite_id)
);
create index on market.passages using gin (search_tsv);
create index on market.passages (industry_key, size_band);

-- Grants: authenticated READS reference data; service_role has full access for the
-- out-of-band ingestion pipeline. NO firm-scoped RLS — there is no firm_id to
-- isolate on; exposure limits live in the retrieval layer (see the header comment).
-- `grant usage on schema market` already exists (20260724013906).
grant select on market.passages to authenticated;
grant all on market.passages to service_role;
