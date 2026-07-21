-- Plans (docs/37): reusable, versioned bundles of initiatives (playbooks,
-- education, advisory items, milestones, manual tasks) an advisor curates once
-- and applies to an engagement. A Plan is a GROUPING/COMPOSITION layer, not a
-- new scoring or content primitive: applying it materializes tasks/milestones
-- into the EXISTING tasks/roadmap_milestones tables (docs/37 §2.3). No scoring,
-- rubric, gap, or assessment table is touched (CLAUDE.md rules 1, 3, 4).
--
-- NAMING: the product term is "Plan", but `plans` is already taken by the Stripe
-- billing tier catalog (20260719000200_billing.sql). So the reusable template is
-- `plan_templates` and its applied instance is `engagement_plans` (docs/37 §8).
--
-- Two template tables (reusable) + two instance tables (the immutable applied
-- record) + two additive annotation columns. Global-vs-tenant methodology
-- follows the advisory_library_items pattern exactly (firm_id null = system,
-- readable by all, service-role writes only; firm_id set = tenant, firm-isolated).
-- The applied record pins the template version in force, mirroring
-- assessments->rubric_version immutability. Owner visibility (docs/37 Q3) reuses
-- the roadmap_milestones owner_engagement_read policy verbatim.

create type plan_source as enum ('system', 'advisor');
create type plan_status as enum ('draft', 'active', 'retired');
create type plan_item_kind as enum ('playbook', 'education', 'advisory', 'milestone', 'manual_task');
create type engagement_plan_status as enum ('active', 'completed', 'removed');

-- ── Templates (reusable, versioned) ────────────────────────────────────────

-- The Plan header. firm_id null = system/seed methodology Plan; set = firm-authored.
create table plan_templates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid references firms (id),            -- null = global/system methodology Plan
  source plan_source not null default 'advisor',
  code text,                                     -- stable code for system Plans (idempotent re-seed)
  name text not null,
  summary text,
  plan_version int not null default 1,           -- versioning (rule 6), mirrors playbooks.version
  status plan_status not null default 'draft',
  created_by uuid references profiles (id)
);
-- System rows are keyed by (code, version) for idempotent re-seeding; firm rows have no code.
create unique index plan_templates_system_code on plan_templates (code, plan_version) where firm_id is null;
create index on plan_templates (firm_id);

-- The ordered contents of a Plan. One reference/inline column set per item_kind.
create table plan_template_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid references firms (id),            -- mirrors parent plan_templates.firm_id (null for system) so RLS is a plain predicate
  plan_template_id uuid not null references plan_templates (id) on delete cascade,
  item_kind plan_item_kind not null,
  playbook_id uuid references playbooks (id),                    -- item_kind = 'playbook'
  content_module_id uuid references content_modules (id),        -- item_kind = 'education'
  advisory_library_item_id uuid references advisory_library_items (id), -- item_kind = 'advisory'
  title text,                                    -- inline copy for milestone / manual_task
  description text,
  owner_role task_owner_role,                    -- inline, for manual_task
  track milestone_track,                         -- inline, for milestone (business|personal)
  target_offset_days int,                        -- inline due-date anchoring (as playbook_task_templates)
  sort_order int not null default 0,
  -- Exactly the right reference/inline column is populated per kind (the same
  -- discipline advisory_library_items uses for its typed columns).
  constraint plan_template_items_kind_ref check (
    (item_kind = 'playbook'
       and playbook_id is not null and content_module_id is null and advisory_library_item_id is null)
    or (item_kind = 'education'
       and content_module_id is not null and playbook_id is null and advisory_library_item_id is null)
    or (item_kind = 'advisory'
       and advisory_library_item_id is not null and playbook_id is null and content_module_id is null)
    or (item_kind = 'milestone'
       and title is not null and track is not null
       and playbook_id is null and content_module_id is null and advisory_library_item_id is null)
    or (item_kind = 'manual_task'
       and title is not null
       and playbook_id is null and content_module_id is null and advisory_library_item_id is null)
  )
);
create index on plan_template_items (firm_id);
create index on plan_template_items (plan_template_id);

-- ── Instances (the immutable applied record) ───────────────────────────────

-- "We applied Plan X, version N, on date D." Pins applied_plan_version and
-- snapshots the name, so later template edits never rewrite applied history
-- (mirrors assessments -> rubric_version, rule 4).
create table engagement_plans (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  plan_template_id uuid not null references plan_templates (id),
  applied_plan_version int not null,             -- template version in force at apply time (the pin)
  name text not null,                            -- snapshot of the Plan name at apply time
  anchor_date date,                              -- forward-lays task/milestone due dates
  applied_by uuid references profiles (id),
  applied_at timestamptz not null default now(),
  status engagement_plan_status not null default 'active'
);
create index on engagement_plans (firm_id);
create index on engagement_plans (engagement_id);
create index on engagement_plans (plan_template_id);

-- The immutable snapshot of what was applied, pointing at the execution rows it
-- produced/claimed. Re-assessment reconcile (docs/37 Q7) only ADDS rows here.
create table engagement_plan_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_plan_id uuid not null references engagement_plans (id) on delete cascade,
  source_plan_template_item_id uuid references plan_template_items (id),  -- template lineage (null-safe)
  item_kind plan_item_kind not null,             -- snapshotted, not joined, so history survives template edits
  task_id uuid references tasks (id),            -- concrete task this item produced/claimed
  milestone_id uuid references roadmap_milestones (id),         -- concrete milestone produced
  content_module_id uuid references content_modules (id),
  advisory_library_item_id uuid references advisory_library_items (id),
  status text                                    -- derived/rolled-up progress convenience
);
create index on engagement_plan_items (firm_id);
create index on engagement_plan_items (engagement_plan_id);

-- ── Additive provenance columns on existing execution tables ───────────────
-- Nullable + backward-compatible: let the roadmap board group/filter by applied
-- plan without a parallel store. They inherit each table's existing RLS.
alter table tasks add column engagement_plan_id uuid references engagement_plans (id);
alter table roadmap_milestones add column engagement_plan_id uuid references engagement_plans (id);
create index on tasks (engagement_plan_id);
create index on roadmap_milestones (engagement_plan_id);

-- ── RLS ────────────────────────────────────────────────────────────────────

-- Templates: the advisory_library_items dual policy — global system rows
-- readable by all (writes service-role only), firm rows full-CRUD within firm.
grant select, insert, update, delete on plan_templates to authenticated;
grant all on plan_templates to service_role;
alter table plan_templates enable row level security;
create policy plan_templates_system_read on plan_templates for select to authenticated
  using (firm_id is null);
create policy plan_templates_advisor_all on plan_templates for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

grant select, insert, update, delete on plan_template_items to authenticated;
grant all on plan_template_items to service_role;
alter table plan_template_items enable row level security;
create policy plan_template_items_system_read on plan_template_items for select to authenticated
  using (firm_id is null);
create policy plan_template_items_advisor_all on plan_template_items for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

-- Instances: standard firm-scoped advisor-all + owner read (docs/37 Q3).
grant select, insert, update, delete on engagement_plans to authenticated;
grant all on engagement_plans to service_role;
alter table engagement_plans enable row level security;
create policy engagement_plans_advisor_all on engagement_plans for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
create policy engagement_plans_owner_read on engagement_plans for select to authenticated
  using (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));

grant select, insert, update, delete on engagement_plan_items to authenticated;
grant all on engagement_plan_items to service_role;
alter table engagement_plan_items enable row level security;
create policy engagement_plan_items_advisor_all on engagement_plan_items for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
create policy engagement_plan_items_owner_read on engagement_plan_items for select to authenticated
  using (app.user_role() = 'owner' and engagement_plan_id in (
    select ep.id from engagement_plans ep
    join engagements e on e.id = ep.engagement_id
    where e.company_id = app.user_company_id()));
