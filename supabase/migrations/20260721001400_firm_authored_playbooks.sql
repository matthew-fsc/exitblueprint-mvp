-- Firm-authored playbooks & content modules, 2026-07-21.
--
-- Playbooks (remediation how-to + task steps) and content_modules (education)
-- were global/seed-only: an advisor's signature methodology could only enter via
-- a developer editing seed files. This extends the Advisory Library pattern
-- (20260712000200): a nullable firm_id + source distinguishes SYSTEM rows
-- (firm_id null, shared methodology, read-only to firms) from FIRM rows (firm_id
-- set, source 'advisor', editable by that firm's staff). Firm-authored playbooks
-- and modules then appear alongside system ones in the Plan builder.
--
-- Scope note: the gap→remediation wiring (gap_playbook_map / gap_content_map)
-- stays GLOBAL for now — firm playbooks are applied to engagements through Plans,
-- not auto-fired from gaps. Firm-specific gap wiring is a later slice.

-- ── Columns ──────────────────────────────────────────────────────────────────
alter table playbooks add column firm_id uuid references firms (id);
alter table playbooks add column source text not null default 'system';
alter table playbooks add column created_by uuid references profiles (id);
create index on playbooks (firm_id);

-- Task templates carry firm_id too (mirrors the parent playbook) so RLS is a
-- direct column check rather than a join.
alter table playbook_task_templates add column firm_id uuid references firms (id);
create index on playbook_task_templates (firm_id);

alter table content_modules add column firm_id uuid references firms (id);
alter table content_modules add column source text not null default 'system';
alter table content_modules add column created_by uuid references profiles (id);
create index on content_modules (firm_id);

-- ── Uniqueness (system vs firm namespaces) ───────────────────────────────────
-- Replace the global unique constraints with partial unique indexes: system rows
-- keep the old guarantee, and each firm gets its own code namespace. The seeder
-- targets the system partial index (…where firm_id is null).
alter table playbooks drop constraint playbooks_code_version_key;
create unique index playbooks_system_code_version on playbooks (code, version) where firm_id is null;
create unique index playbooks_firm_code_version on playbooks (firm_id, code, version) where firm_id is not null;

alter table content_modules drop constraint content_modules_code_key;
create unique index content_modules_system_code on content_modules (code) where firm_id is null;
create unique index content_modules_firm_code on content_modules (firm_id, code) where firm_id is not null;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Reads return system rows (firm_id null) plus the caller's own firm rows,
-- replacing the read-everything methodology_read policy. Writes are limited to a
-- firm's own rows by its staff; system rows stay read-only to firms. DML grants
-- already exist (rls.sql grants all-tables to authenticated); RLS is the gate.

drop policy methodology_read on playbooks;
create policy playbooks_read on playbooks for select to authenticated
  using (firm_id is null or firm_id = app.user_firm_id());
create policy playbooks_firm_write on playbooks for all to authenticated
  using (firm_id is not null and firm_id = app.user_firm_id()
         and app.user_role() = any (array['advisor','reviewer','admin']::app_role[]))
  with check (firm_id is not null and firm_id = app.user_firm_id()
         and app.user_role() = any (array['advisor','reviewer','admin']::app_role[]));

drop policy methodology_read on playbook_task_templates;
create policy playbook_task_templates_read on playbook_task_templates for select to authenticated
  using (firm_id is null or firm_id = app.user_firm_id());
create policy playbook_task_templates_firm_write on playbook_task_templates for all to authenticated
  using (firm_id is not null and firm_id = app.user_firm_id()
         and app.user_role() = any (array['advisor','reviewer','admin']::app_role[]))
  with check (firm_id is not null and firm_id = app.user_firm_id()
         and app.user_role() = any (array['advisor','reviewer','admin']::app_role[]));

drop policy methodology_read on content_modules;
create policy content_modules_read on content_modules for select to authenticated
  using (firm_id is null or firm_id = app.user_firm_id());
create policy content_modules_firm_write on content_modules for all to authenticated
  using (firm_id is not null and firm_id = app.user_firm_id()
         and app.user_role() = any (array['advisor','reviewer','admin']::app_role[]))
  with check (firm_id is not null and firm_id = app.user_firm_id()
         and app.user_role() = any (array['advisor','reviewer','admin']::app_role[]));
