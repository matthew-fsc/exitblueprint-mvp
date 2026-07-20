-- Per-engagement, view-only external collaborators (CPA, attorney, etc.), 2026-07-20.
--
-- An engagement's "deal team" now extends beyond the owner: a client's own CPA or
-- attorney can be invited to a READ-ONLY view of a SINGLE engagement, assembled
-- through the same owner-portal invite workflow (Clerk organization invitation in
-- prod, dev direct-insert locally). They sign in and land in the owner portal,
-- scoped to just the one engagement they were invited to — never the whole
-- company, never the firm.
--
-- This migration is the SCHEMA half; nothing here uses the new 'collaborator'
-- app_role value, so it is safe to run in one transaction. The RLS policies that
-- reference 'collaborator' live in the NEXT migration (an enum value cannot be
-- added and used in the same transaction — migrate.ts commits each file
-- separately, the same split the 'reviewer' role used).

-- 1. The new login role. profiles.role stays the RLS source of truth; a
--    collaborator is a read-only, engagement-scoped participant.
alter type app_role add value if not exists 'collaborator';

-- 2. Descriptive kinds + invite lifecycle for the roster the advisor assembles.
create type collaborator_kind as enum ('cpa', 'attorney', 'advisor', 'other');
create type collaborator_status as enum ('invited', 'active', 'revoked');

-- 3. profiles gains an engagement scope. Owners carry company_id; a collaborator
--    additionally carries engagement_id — the single engagement they may read.
alter table profiles add column if not exists engagement_id uuid references engagements (id);
create index if not exists profiles_engagement_id_idx on profiles (engagement_id);

-- 4. The roster: who is on an engagement's portal team, and the state of their
--    invite. Rows are written by the invite/revoke functions (service role); staff
--    read them under RLS to render and manage the team. user_id is filled once the
--    collaborator's profile is provisioned (on Clerk invite acceptance, or
--    immediately on the dev path).
create table engagement_collaborators (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id) on delete cascade,
  company_id uuid not null references companies (id),
  email text not null,
  full_name text,
  kind collaborator_kind not null default 'other',
  status collaborator_status not null default 'invited',
  invited_by uuid references profiles (id),
  user_id text,                 -- the provisioned identity (Clerk id / dev uuid), null while pending
  revoked_at timestamptz,
  unique (engagement_id, email) -- one row per (engagement, invitee); re-invites update in place
);
create index on engagement_collaborators (firm_id);
create index on engagement_collaborators (engagement_id);

-- 5. The engagement-scope helper, mirroring app.user_company_id() — reads the
--    caller's engagement_id from their profile via the verified Clerk/dev subject.
create or replace function app.user_engagement_id() returns uuid
language sql stable security definer set search_path = public
as $$
  select engagement_id from public.profiles where user_id = auth.jwt() ->> 'sub'
$$;
grant execute on function app.user_engagement_id() to authenticated;

-- 6. Grants + RLS for the roster. Staff (advisor/reviewer/admin) manage their own
--    firm's collaborators; the collaborator read policies on the domain tables
--    (companies/engagements/assessments/…) are added in the next migration since
--    they reference the new 'collaborator' role value.
grant select, insert, update, delete on engagement_collaborators to authenticated;
grant all on engagement_collaborators to service_role;
alter table engagement_collaborators enable row level security;

create policy staff_firm_all on engagement_collaborators for all to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[]) and firm_id = app.user_firm_id())
  with check (app.user_role() = any (array['advisor','reviewer','admin']::app_role[]) and firm_id = app.user_firm_id());
