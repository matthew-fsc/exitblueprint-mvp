-- Let removed system advisory items be pruned without blocking on applied plans.
--
-- The methodology seed (server/seed-methodology.ts) rebuilds the system catalogs on
-- each run, but advisory_library_items had no orphan cleanup (unlike library_tasks),
-- so system advisory items dropped from the seed file lingered forever. Adding that
-- cleanup means the seed will now DELETE removed system advisory rows — and
-- engagement_plan_items.advisory_library_item_id references them via an FK created
-- with the default NO ACTION (20260721000100_plans.sql), which would block the
-- delete the same way the plan-template lineage FK did (20260723232946).
--
-- engagement_plan_items snapshots item_kind and the concrete pointer is the record
-- of what an applied plan surfaced; dropping a since-removed advisory item is the
-- same "null-safe, history survives via the snapshot" case as source lineage, so
-- ON DELETE SET NULL is correct here too. (Its sibling reference,
-- plan_template_items.advisory_library_item_id, deliberately keeps NO ACTION: that
-- table's kind_ref check requires the column NOT NULL for item_kind='advisory', so
-- SET NULL would violate the check — the seed cleanup skips any advisory item a
-- plan_template_item still references instead.)
alter table engagement_plan_items
  drop constraint engagement_plan_items_advisory_library_item_id_fkey,
  add constraint engagement_plan_items_advisory_library_item_id_fkey
    foreign key (advisory_library_item_id) references advisory_library_items (id)
    on delete set null;
