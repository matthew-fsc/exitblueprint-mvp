-- Engagement comments: a collaborator-writable thread, 2026-07-21.
--
-- Until now an external collaborator (a client's CPA/attorney invited to the
-- read-only portal) could only LOOK at one engagement — nothing to write, so no
-- reason to come back. This adds one shared collaboration primitive: a comment
-- thread on an engagement that firm staff, the engagement's owner, and the
-- engagement's collaborators can all read and post to. It is the only thing a
-- collaborator may write, and it stays strictly scoped to the single engagement
-- each participant can already see.
--
-- Author identity fields (name/role) are display-only; authorization is the RLS
-- below. firm_id is carried per the multi-tenant rule and validated against the
-- engagement on every insert.

create table engagement_comments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id) on delete cascade,
  author_profile_id uuid references profiles (id),
  author_name text,
  author_role app_role,
  body text not null
);
create index on engagement_comments (engagement_id);
create index on engagement_comments (firm_id);

-- New tables are not covered by the historical all-tables grant; grant explicitly.
grant select, insert, update, delete on engagement_comments to authenticated;
grant all on engagement_comments to service_role;
alter table engagement_comments enable row level security;

-- Staff (advisor/reviewer/admin) read + write their own firm's threads. The
-- insert check also confirms the target engagement belongs to that firm.
create policy engagement_comments_staff_all on engagement_comments for all to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id())
  with check (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id()
         and exists (select 1 from engagements e where e.id = engagement_id and e.firm_id = firm_id));

-- The engagement's collaborator: read + post on their single engagement only.
create policy engagement_comments_collaborator_read on engagement_comments for select to authenticated
  using (app.user_role() = 'collaborator' and engagement_id = app.user_engagement_id());
create policy engagement_comments_collaborator_insert on engagement_comments for insert to authenticated
  with check (app.user_role() = 'collaborator' and engagement_id = app.user_engagement_id()
              and firm_id = (select firm_id from engagements where id = engagement_id));

-- The engagement's owner: read + post on any engagement of their company.
create policy engagement_comments_owner_read on engagement_comments for select to authenticated
  using (app.user_role() = 'owner'
         and engagement_id in (select id from engagements where company_id = app.user_company_id()));
create policy engagement_comments_owner_insert on engagement_comments for insert to authenticated
  with check (app.user_role() = 'owner'
              and firm_id = (select firm_id from engagements where id = engagement_id)
              and engagement_id in (select id from engagements where company_id = app.user_company_id()));
