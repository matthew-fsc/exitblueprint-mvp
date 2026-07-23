-- Sever plan-template lineage on delete instead of blocking it (docs/37, docs/02).
--
-- engagement_plan_items.source_plan_template_item_id is documented as "null-safe"
-- template lineage: the concrete rows an applied plan produced (task_id,
-- milestone_id, content/advisory ids) and the item_kind are snapshotted on the
-- engagement_plan_items row, so applied-plan history survives a template item being
-- deleted. But the FK (20260721000100_plans.sql) was created with the default
-- NO ACTION, so deleting any referenced template item was blocked outright.
--
-- Two routine paths delete plan_template_items and both hit this:
--   • Methodology re-seed (server/seed-methodology.ts) clears and rebuilds every
--     SYSTEM plan's items on each `npm run db:seed`, which failed once any
--     engagement plan had been applied ("update or delete on table
--     plan_template_items violates foreign key constraint
--     engagement_plan_items_source_plan_template_item_id_fkey").
--   • Editing a draft Plan in place (server/plans.ts) replaces its item set.
--
-- ON DELETE SET NULL is the behavior the column was always documented to carry
-- ("null-safe if template item later deleted", docs/37 line 214): the delete
-- succeeds and the lineage pointer becomes null. This is exactly the manual
-- null-out the playbook-retirement migration (20260722202931) already performed by
-- hand before deleting, promoted to a schema-level guarantee so every delete path
-- gets it for free.
alter table engagement_plan_items
  drop constraint engagement_plan_items_source_plan_template_item_id_fkey,
  add constraint engagement_plan_items_source_plan_template_item_id_fkey
    foreign key (source_plan_template_item_id) references plan_template_items (id)
    on delete set null;
