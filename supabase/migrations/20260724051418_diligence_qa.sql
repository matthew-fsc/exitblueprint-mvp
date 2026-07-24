-- Diligence Q&A: answer a buyer's diligence question from the engagement's own
-- structured, cited knowledge. 2026-07-24.
--
-- The answer half of the intelligence runtime (docs/sellside-ai/05 §4). A question
-- is answered FROM the engagement's own citable facts — verified financial inputs,
-- ready data-room items, fired gaps, advisory findings — retrieved deterministically
-- (server/intelligence/retrieval.ts), drafted by the shared runtime, and DEGRADED
-- TO retrieval-only when the AI call fails (no credit in the account), exactly like
-- the deliverables path. Each answer is an immutable snapshot (CLAUDE.md rule 4)
-- stamped with prompt_version + model (rule 6); re-asking makes a NEW row.
--
-- The AI never touches this table to grade anything: `evidence` is the deterministic,
-- cited source passages (jsonb) and `answer_md` is draft prose FROM them. `mode`
-- records whether the AI drafted the answer ('ai') or the deterministic composer
-- rendered the source evidence ('retrieval_only'). firm_id is carried per the
-- multi-tenant rule and validated against the engagement on every insert.

create table diligence_qa (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assessment_id uuid references assessments (id),
  question text not null,
  answer_md text not null,
  mode text not null check (mode in ('ai', 'retrieval_only')),
  model text not null,
  prompt_version text not null,
  evidence jsonb not null default '[]'
);
create index on diligence_qa (firm_id);
create index on diligence_qa (engagement_id);
create index on diligence_qa (assessment_id);

-- New tables are not covered by the historical all-tables grant; grant explicitly.
-- Insert + select only: an answer is immutable once written (rule 4).
grant select, insert on diligence_qa to authenticated;
grant all on diligence_qa to service_role;

alter table diligence_qa enable row level security;

-- Staff (advisor/reviewer/admin) read + write their own firm's Q&A; mirrors the
-- diligence_simulation_runs staff policy. The insert check also confirms the
-- target engagement belongs to that firm.
create policy staff_firm_read on diligence_qa for select to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id());
create policy staff_firm_insert on diligence_qa for insert to authenticated
  with check (
    app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
    and firm_id = app.user_firm_id()
    and exists (select 1 from engagements e where e.id = engagement_id and e.firm_id = firm_id)
  );
