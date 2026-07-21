-- Firm professional directory: make it self-serve for advisors, 2026-07-21.
--
-- The directory (firm_professionals, 20260721000400) originally restricted
-- writes to admins — the directory was treated as an org asset that only the
-- admin curates. In practice the person WITH the rolodex is the working
-- advisor, and routing every contact through an admin is the single biggest
-- friction to getting a network into the tool. This relaxes writes so any firm
-- STAFF (advisor/reviewer/admin) can add and maintain their firm's contacts,
-- matching how engagement_professionals links are already staff-writable.
-- Reads were already staff-wide; firm isolation is unchanged (firm_id must be
-- the caller's firm on every row).

drop policy if exists firm_professionals_admin_write on firm_professionals;
drop policy if exists firm_professionals_staff_read on firm_professionals;

-- Single staff policy: any advisor/reviewer/admin reads and writes their own
-- firm's directory rows (mirrors engagement_professionals_staff_all).
create policy firm_professionals_staff_all on firm_professionals for all to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id())
  with check (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id());
