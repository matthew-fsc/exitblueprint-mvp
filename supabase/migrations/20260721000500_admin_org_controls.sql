-- Real admin organizational controls, 2026-07-21.
--
-- 'admin' has, until now, been a firm-staff role with byte-for-byte the SAME
-- data access as 'advisor' (20260720000100_admin_firm_access added admin policies
-- that mirror the advisor ones additively). That made admin a label, not a
-- control. For a practice of five this slice makes admin a real ORGANIZATIONAL
-- role: the firm's org-level assets (branding, and — in the companion migration —
-- the professional directory) are administered by admins, while advisors do the
-- client work. Enforced here at the database, not just hidden in the UI.
--
-- Two enforcement points:
--   1. Branding is admin-only to WRITE (any staff still READ it to render).
--   2. An engagement's owning advisor can only be reassigned server-side
--      (service_role), which the admin-scoped assign-engagement function uses.

-- ── 1. Branding: admin-only writes ─────────────────────────────────────────────
-- firm_branding had two policies: firm_member_read (any firm member reads — kept,
-- so owner portals and client reports still render the firm's identity) and
-- advisor_firm_write (advisor `for all`). Dropping the advisor write policy leaves
-- writes to the admin_firm_all policy from 20260720000100 — so only admins change
-- the firm's white-label identity. Reads are untouched.
drop policy if exists advisor_firm_write on firm_branding;

-- ── 2. Engagement ownership: reassignment is server-authoritative ───────────────
-- engagements is advisor/admin `for all`, so any advisor could UPDATE any column
-- of any engagement in their firm — including advisor_id, silently reassigning an
-- engagement to a colleague. Reassignment is an org control (who on the team owns
-- what), so it must go through the admin-scoped assign-engagement function, which
-- runs as service_role. This trigger freezes advisor_id against every end-user
-- role (authenticated/anon) and lets the trusted backend through — the same
-- role-guarded pattern as the completed-assessment immutability triggers
-- (20260718000200). Creation (INSERT, done server-side in create-engagement) and
-- every other engagement UPDATE (status, target window) are unaffected.
create or replace function app.guard_engagement_advisor_reassign()
returns trigger
language plpgsql
as $$
begin
  -- Trusted backend (service_role) and maintenance roles pass through; only
  -- end-user JWT roles are constrained.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.advisor_id is distinct from old.advisor_id then
    raise exception
      'engagement % owner is reassigned through the admin assign-engagement function, not a direct update', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger guard_engagement_advisor_reassign
  before update on engagements
  for each row execute function app.guard_engagement_advisor_reassign();
