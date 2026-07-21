-- Plan version lineage (docs/37 §3.1, decided 2026-07-21). Firm-authored Plans
-- have no `code` to chain versions by (only system Plans do), so editing an
-- ACTIVE Plan mints a NEW plan_templates row that shares a lineage_id with the
-- original (plan_version + 1) and retires the prior row. lineage_id groups every
-- version of one logical Plan; the "current" version is the newest non-retired
-- row for a lineage_id. Nullable + backfilled to each existing row's own id so
-- every Plan is its own lineage root. No RLS change — lineage_id rides the
-- table's existing policies.
alter table plan_templates add column lineage_id uuid;
update plan_templates set lineage_id = id where lineage_id is null;
create index on plan_templates (lineage_id);
