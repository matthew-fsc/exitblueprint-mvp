-- Add the 'task' plan-item kind (a Plan item that references a reusable
-- library_task). Split into its own migration because Postgres forbids USING a
-- newly-added enum value in the same transaction that adds it, and the migration
-- runner wraps each file in one transaction — the next migration
-- (…_unify_playbooks_into_plans.sql) references 'task' in a CHECK constraint.
alter type plan_item_kind add value if not exists 'task';
