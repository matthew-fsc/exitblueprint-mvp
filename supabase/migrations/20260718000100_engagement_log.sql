-- Institutional memory (docs/20/21, Category B): capture the advisor's reasoning
-- and decisions, not just the actions the system already records. An engagement
-- log entry is a structured record of a meeting, a decision, or the rationale
-- behind a recommendation — optionally attached to the specific gap it explains,
-- so the "why" compounds into institutional knowledge rather than living in
-- someone's memory or a disconnected doc.
--
-- Deterministic and advisor-authored; nothing here computes or influences a score
-- (rule 2). Staff-only: this is internal advisory logic, not owner-facing.

create type engagement_log_kind as enum ('meeting', 'decision', 'rationale', 'note');

create table engagement_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  author_id uuid references profiles (id),
  kind engagement_log_kind not null default 'note',
  occurred_on date not null default current_date, -- backdatable, for engagements in flight
  title text not null,
  detail text,
  gap_id uuid references gaps (id) on delete set null -- the recommendation this explains
);
create index on engagement_log (firm_id);
create index on engagement_log (engagement_id);
create index on engagement_log (gap_id);

grant select, insert, update, delete on engagement_log to authenticated;
grant all on engagement_log to service_role;

alter table engagement_log enable row level security;

-- Staff (advisor + reviewer) full CRUD within their firm. No owner policy —
-- internal advisory reasoning is not client-facing.
create policy staff_firm_all on engagement_log for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
