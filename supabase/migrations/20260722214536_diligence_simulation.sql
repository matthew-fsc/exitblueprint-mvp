-- Diligence Simulation: rehearse the buyer interrogation before the market runs
-- it. 2026-07-22.
--
-- The proactive half of the buyer lens (docs/20, docs/40 §3), built on top of the
-- institutional reviewer (server/institutional-review.ts). fireAdvisoryItems
-- reports the questions a buyer *will* ask; this persists a full rehearsal — a
-- ranked, severity-keyed blind-spot report over an engagement's latest completed
-- assessment. A run is an immutable snapshot (CLAUDE.md rule 4): the deterministic
-- findings (severity, diligence area, remediation pointer) plus the labeled DRAFT
-- narrative that frames them, stamped with prompt_version (rule 6). Re-running
-- produces a NEW run; rows are insert-only (no update/delete grant to authenticated).
--
-- The AI never touches these tables to grade anything: severity/area/remediation
-- are produced by the engine + catalog server-side (server/diligence-simulation.ts).
-- narrative_md is draft prose FROM those findings. firm_id is carried per the
-- multi-tenant rule and validated against the engagement/run on every insert.

create table diligence_simulation_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assessment_id uuid references assessments (id),
  prompt_version text not null,
  model text not null,
  finding_count int not null default 0,
  narrative_md text not null
);
create index on diligence_simulation_runs (firm_id);
create index on diligence_simulation_runs (engagement_id);
create index on diligence_simulation_runs (assessment_id);

create table diligence_simulation_findings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  run_id uuid not null references diligence_simulation_runs (id) on delete cascade,
  rank int not null,
  severity text not null,       -- critical | high | med | low (normalized in code)
  area text not null,           -- the diligence area (a dimension name, evidence, tracking)
  source_kind text not null,    -- gap | evidence | buyer_question | untracked
  title text not null,
  why text not null,            -- why a diligence process flags it (deterministic copy)
  remediation_kind text,        -- plan | library | evidence | roadmap | null
  remediation_label text,
  remediation_ref text          -- opaque id (Plan template / advisory item), null for a surface
);
create index on diligence_simulation_findings (firm_id);
create index on diligence_simulation_findings (run_id);

-- New tables are not covered by the historical all-tables grant; grant explicitly.
-- Insert + select only: a run is immutable once written (rule 4).
grant select, insert on diligence_simulation_runs, diligence_simulation_findings to authenticated;
grant all on diligence_simulation_runs, diligence_simulation_findings to service_role;

alter table diligence_simulation_runs enable row level security;
alter table diligence_simulation_findings enable row level security;

-- Staff (advisor/reviewer/admin) read + write their own firm's runs; mirrors the
-- engagement_comments staff policy. The insert check also confirms the target
-- engagement belongs to that firm.
create policy staff_firm_read on diligence_simulation_runs for select to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id());
create policy staff_firm_insert on diligence_simulation_runs for insert to authenticated
  with check (
    app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
    and firm_id = app.user_firm_id()
    and exists (select 1 from engagements e where e.id = engagement_id and e.firm_id = firm_id)
  );

create policy staff_firm_read on diligence_simulation_findings for select to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id());
create policy staff_firm_insert on diligence_simulation_findings for insert to authenticated
  with check (
    app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
    and firm_id = app.user_firm_id()
    and exists (select 1 from diligence_simulation_runs r where r.id = run_id and r.firm_id = firm_id)
  );
