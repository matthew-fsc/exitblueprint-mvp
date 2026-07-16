-- Beta Requirement 6: feedback + usage instrumentation. A single structured,
-- SQL-queryable event table for the advisor journey — onboarding steps,
-- assessment sections started/abandoned, questions skipped, documents
-- requested vs uploaded, time per section, review-queue turnaround, and score
-- delivery. No third-party analytics dependency. Append-only; never touches a
-- score.
create table usage_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(), -- server receipt time
  firm_id uuid not null references firms (id),
  actor_user_id uuid,                 -- auth.users id of the actor
  actor_profile_id uuid references profiles (id),
  engagement_id uuid references engagements (id),
  event_type text not null,           -- coarse bucket: 'onboarding','assessment','document','report','review'
  event_name text not null,           -- specific action: 'section_viewed','report_downloaded',…
  properties jsonb not null default '{}',
  session_id text,                    -- per-tab id, so a session's events group
  occurred_at timestamptz not null default now() -- client event time
);
create index on usage_events (firm_id, occurred_at desc);
create index on usage_events (session_id);
create index on usage_events (engagement_id);
create index on usage_events (event_type, event_name);

-- Authenticated users emit events for their own firm; advisors/reviewers read
-- their firm's stream. Append-only: no update/delete grants or policies.
grant select, insert on usage_events to authenticated;
grant all on usage_events to service_role;

alter table usage_events enable row level security;
create policy firm_insert on usage_events for insert to authenticated
  with check (firm_id = app.user_firm_id());
create policy staff_firm_read on usage_events for select to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
