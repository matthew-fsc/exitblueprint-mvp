-- Minimal stand-in for the parts of a Supabase database our migrations depend
-- on, so they can run against plain Postgres (CI, restricted dev containers).
-- Never applied to a real Supabase database (scripts/migrate.ts checks for the
-- auth schema first). Keep this file limited to what migrations reference.

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);

-- Mirrors Supabase's auth.uid(): the `sub` claim of the request JWT.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

-- Mirrors Supabase's auth.jwt(): the full verified claim set as jsonb. Under
-- third-party auth (Clerk), the subject (`sub`) is a text user id like
-- `user_2ab…`, so identity lookups read `auth.jwt() ->> 'sub'` (text) rather
-- than auth.uid() (which casts to uuid). Present natively on real Supabase;
-- defined here so migrations that reference it also run on plain Postgres.
create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
