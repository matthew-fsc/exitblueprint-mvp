-- F5: dual-track roadmap milestones. The gap-derived remediation tasks live in
-- the existing `tasks` table (instantiated from playbook templates); milestones
-- are advisor-entered target states on two tracks — business readiness and the
-- owner's personal / wealth planning. Additive. RLS: advisor full within firm,
-- owner read-only.

create type milestone_track as enum ('business', 'personal');

create table roadmap_milestones (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  track milestone_track not null,
  title text not null,
  description text,
  target_date date,
  completed_at timestamptz,
  linked_gap_id uuid references gaps (id),
  linked_task_id uuid references tasks (id),
  created_by uuid references profiles (id),
  sort_order int not null default 0
);

create index on roadmap_milestones (firm_id);
create index on roadmap_milestones (engagement_id);

grant select, insert, update, delete on roadmap_milestones to authenticated;
grant all on roadmap_milestones to service_role;

alter table roadmap_milestones enable row level security;

create policy advisor_firm_all on roadmap_milestones for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

create policy owner_engagement_read on roadmap_milestones for select to authenticated
  using (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));
