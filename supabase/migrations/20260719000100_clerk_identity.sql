-- Clerk as identity provider via Supabase third-party auth (docs/24, decision
-- 2026-07-18). Clerk issues the session JWT; Supabase/our compute service verify
-- it against Clerk's JWKS. The subject (`sub`) is a Clerk user id string
-- (`user_2ab…`), not a uuid — so identity now flows through `auth.jwt() ->> 'sub'`
-- (text) instead of `auth.uid()` (uuid).
--
-- RLS-preserving by design: every firm-isolation policy calls the three
-- app.user_* helpers, so we change ONLY (a) the identity column types, (b) what
-- those three helpers read, and (c) the one policy that compared to auth.uid()
-- directly. No other policy body changes. Clerk Organizations map to firms via
-- firms.clerk_org_id; the internal firm_id uuid stays the key, so every FK is
-- untouched. See scripts/rls-test.ts — all firm-isolation checks must stay green
-- under Clerk-shaped (text) subjects.

-- 1. Identity columns widen uuid -> text to hold Clerk user ids.

-- The own-profile policy references user_id, so it must be dropped before the
-- column type can change; it is recreated against the text identity in step 4.
drop policy if exists own_profile_read on profiles;

-- profiles.user_id is the identity of record. Drop its auth.users FK (Clerk owns
-- the user table now) but keep the UNIQUE constraint (one profile per identity).
alter table profiles drop constraint if exists profiles_user_id_fkey;
alter table profiles alter column user_id type text using user_id::text;

-- Audit/usage actor ids also hold the auth-user id (now a Clerk id). No FKs.
alter table data_access_log alter column actor_user_id type text using actor_user_id::text;
alter table usage_events   alter column actor_user_id type text using actor_user_id::text;

-- 2. Firm <-> Clerk Organization mapping. firm_id (uuid) remains the internal key.
alter table firms add column if not exists clerk_org_id text unique;

-- 3. The only behavioral change: the three security-definer helpers read the
--    Clerk subject instead of auth.uid(). Signatures/attributes unchanged, so
--    every policy that calls them keeps working verbatim.
create or replace function app.user_role() returns app_role
language sql stable security definer set search_path = public
as $$
  select role from public.profiles where user_id = auth.jwt() ->> 'sub'
$$;

create or replace function app.user_firm_id() returns uuid
language sql stable security definer set search_path = public
as $$
  select firm_id from public.profiles where user_id = auth.jwt() ->> 'sub'
$$;

create or replace function app.user_company_id() returns uuid
language sql stable security definer set search_path = public
as $$
  select company_id from public.profiles where user_id = auth.jwt() ->> 'sub'
$$;

-- 4. Recreate the own-profile policy (dropped in step 1) against the text
--    identity — the one policy that referenced auth.uid() directly.
create policy own_profile_read on profiles for select to authenticated
  using (user_id = auth.jwt() ->> 'sub');
