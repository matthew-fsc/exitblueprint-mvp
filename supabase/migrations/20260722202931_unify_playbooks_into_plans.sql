-- Unify playbooks into Plans; make tasks first-class Library items (docs/37).
--
-- The product had TWO grouping layers of the same shape (a playbook is a bundle
-- of tasks; a Plan is a bundle that references playbooks) and its atomic items
-- were split across surfaces. This retires the playbook primitive entirely:
--   • library_tasks — the reusable, atomic task template (replaces
--     playbook_task_templates), a first-class Library item alongside education
--     (content_modules) and advisory items.
--   • plan_item_kind gains 'task' (references a library_task); 'playbook' is
--     retired from use (the enum value is kept — Postgres can't drop enum values —
--     but the check constraint no longer admits it).
--   • gap_plan_map replaces gap_playbook_map: a gap definition links to the
--     remediation Plan (the "roadmap initiative") that addresses it. Applying a
--     Plan is now the SOLE way tasks reach the roadmap (server/plans.ts); the
--     standalone gap→task loop is gone.
--   • tasks.library_task_id replaces tasks.playbook_id as the once-per-engagement
--     idempotency key (claim-not-duplicate interlock, docs/37 §1.4).
--
-- Prescription only — no assessment/dimension/sub-score/gap table is touched
-- (CLAUDE.md rules 1, 3, 4); no rubric_version change. Global-vs-tenant + RLS
-- follow the playbooks/content_modules pattern verbatim.
--
-- NOTE (existing databases): methodology is re-seeded (npm run db:seed), so the
-- system playbooks/tasks/maps are rebuilt as Plans + library_tasks. Any tenant
-- (firm-authored) playbooks and the tasks.playbook_id provenance on live
-- engagements are dropped by this migration — acceptable pre-beta; re-seed after.

-- (The 'task' plan_item_kind value is added by the preceding migration
-- 20260722202930_plan_item_task_kind.sql — a new enum value cannot be USED in the
-- same transaction it is added, so it lives in its own file.)

-- ── 1. library_tasks: the atomic, reusable task template ─────────────────────
-- firm_id null = system methodology (service-role writes only); set = firm IP.
-- RLS mirrors playbooks (20260721001400): read global-or-own, write own.
create table library_tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid references firms (id),                  -- null = system methodology
  source text not null default 'system',
  code text,                                           -- stable code for system rows (idempotent re-seed)
  title text not null,
  description text,
  default_owner_role task_owner_role not null,
  dimension_code text,                                 -- readiness area (for applicability/coverage)
  target_offset_days int,                              -- due-date anchoring when applied
  created_by uuid references profiles (id)
);
create unique index library_tasks_system_code on library_tasks (code) where firm_id is null;
create unique index library_tasks_firm_code on library_tasks (firm_id, code) where firm_id is not null;
create index on library_tasks (firm_id);

grant select, insert, update, delete on library_tasks to authenticated;
grant all on library_tasks to service_role;
alter table library_tasks enable row level security;
create policy library_tasks_read on library_tasks for select to authenticated
  using (firm_id is null or firm_id = app.user_firm_id());
create policy library_tasks_firm_write on library_tasks for all to authenticated
  using (firm_id is not null and firm_id = app.user_firm_id()
         and app.user_role() = any (array['advisor','reviewer','admin']::app_role[]))
  with check (firm_id is not null and firm_id = app.user_firm_id()
         and app.user_role() = any (array['advisor','reviewer','admin']::app_role[]));

-- ── 3. plan_template_items: task kind replaces the playbook reference ─────────
alter table plan_template_items add column library_task_id uuid references library_tasks (id);
alter table plan_template_items drop constraint plan_template_items_kind_ref;
alter table plan_template_items drop column playbook_id;
alter table plan_template_items add constraint plan_template_items_kind_ref check (
  (item_kind = 'task'
     and library_task_id is not null and content_module_id is null and advisory_library_item_id is null)
  or (item_kind = 'education'
     and content_module_id is not null and library_task_id is null and advisory_library_item_id is null)
  or (item_kind = 'advisory'
     and advisory_library_item_id is not null and library_task_id is null and content_module_id is null)
  or (item_kind = 'milestone'
     and title is not null and track is not null
     and library_task_id is null and content_module_id is null and advisory_library_item_id is null)
  or (item_kind = 'manual_task'
     and title is not null
     and library_task_id is null and content_module_id is null and advisory_library_item_id is null)
);

-- ── 4. tasks: library_task_id is the new idempotency key ─────────────────────
alter table tasks add column library_task_id uuid references library_tasks (id);
create index on tasks (library_task_id);
alter table tasks drop column playbook_id;

-- ── 5. gap_plan_map: a gap links to its remediation Plan ─────────────────────
-- Replaces gap_playbook_map. Global methodology, readable by all (like the old
-- gap_playbook_map methodology_read). Populated by the seed from the gap→playbook
-- map, resolving each playbook to the Plan that now carries its tasks.
create table gap_plan_map (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  gap_definition_id uuid not null references gap_definitions (id),
  plan_template_id uuid not null references plan_templates (id),
  priority int not null default 1,
  unique (gap_definition_id, plan_template_id)
);
create index on gap_plan_map (gap_definition_id);
create index on gap_plan_map (plan_template_id);
grant select on gap_plan_map to authenticated;
grant all on gap_plan_map to service_role;
alter table gap_plan_map enable row level security;
create policy gap_plan_map_read on gap_plan_map for select to authenticated using (true);

-- ── 6. Retire the playbook primitive ─────────────────────────────────────────
-- Drop the FK holders first (gap_playbook_map, playbook_task_templates), then the
-- table itself. tasks.playbook_id and plan_template_items.playbook_id were dropped
-- above.
drop table gap_playbook_map;
drop table playbook_task_templates;
drop table playbooks;
