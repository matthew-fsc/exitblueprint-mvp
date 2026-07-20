-- Advisor-controlled roadmap ordering (UI cleanup, 2026-07-20).
--
-- `tasks.sequence` is NOT a free ordering field — it is the per-playbook template
-- position and forms the idempotency key (playbook_id:sequence) that
-- server/roadmap.ts uses to avoid re-inserting a task on every reschedule.
-- Mutating it to reorder the list would make generation re-create duplicates.
-- So manual ordering gets its own column: nullable, no default. Null sorts after
-- ordered tasks (a freshly generated plan reads by due date until an advisor
-- drags it). No RLS change — the existing tasks policies cover every column.
alter table tasks add column if not exists display_order int;
