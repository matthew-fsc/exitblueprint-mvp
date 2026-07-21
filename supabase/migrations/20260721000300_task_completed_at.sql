-- tasks.completed_at (docs/37 PL4). Plan progress needs to know WHEN a task
-- finished, not just that it is done — that timestamp is what lets a reassessment
-- be "properly placed": recommended once a Plan completes AFTER the last
-- measurement, rather than on a blind 90-day clock. Milestones already carry
-- completed_at; tasks only had a status enum.
--
-- Maintained by a BEFORE trigger so it stays correct no matter who writes the
-- status — the roadmap board updates tasks directly via supabase, and server
-- functions write too. Moving to 'done' stamps now(); moving off 'done' clears it.
alter table tasks add column completed_at timestamptz;

-- Backfill existing done tasks with a deterministic proxy (created_at) so history
-- isn't null; the trigger stamps the real transition time from here on.
update tasks set completed_at = created_at where status = 'done' and completed_at is null;

create or replace function app.tasks_stamp_completed_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    new.completed_at := now();
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end $$;

create trigger tasks_completed_at
  before insert or update on tasks
  for each row execute function app.tasks_stamp_completed_at();
