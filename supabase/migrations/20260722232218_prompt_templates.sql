-- Narrative prompt override registry (docs/04). The AI narrative prompts ship as
-- bundled files (prompts/<version>.md); this table lets a platform superadmin
-- override a prompt's body WITHOUT a code deploy — server/narrative.ts resolves
-- the body DB-first and falls back to the bundled file. Keeping the door open to
-- tune narratives in-system also removes a class of "forgot to ship the file"
-- bug: a DB override works even if the file is missing from the image.
--
-- This is GLOBAL operational config (no firm_id) and must be invisible to
-- tenants — one firm must never be able to change generation for every firm — so
-- it lives in the walled, service-role-only `analytics` schema alongside the
-- other platform-admin surfaces. It is here for that isolation, not because it is
-- "analytics"; the schema is simply the established service-role-only home
-- (usage revoked from public, granted to service_role only). No firm data.
--
-- The numeral firewall + rule-based composer fallback (server/narrative.ts) are
-- code, independent of prompt text, so an edited or empty prompt can never inject
-- invented numbers or hard-fail a delivery (rules 1/2). prompt_version stamped on
-- generated_documents stays the provenance key; a DB override reuses the same key.
create table analytics.prompt_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique, -- prompt version id, e.g. 'owner_report.v1' (the file stem)
  body_md text not null,
  updated_at timestamptz not null default now(),
  updated_by text -- Clerk subject of the superadmin who last edited (audit)
);

-- service_role ONLY — never authenticated/anon (the analytics schema has no usage
-- grant to them, so this table is unreachable from any tenant JWT path). The
-- narrative service and the platform-admin set/reset functions both use the
-- service-role connection.
grant select, insert, update, delete on analytics.prompt_templates to service_role;
