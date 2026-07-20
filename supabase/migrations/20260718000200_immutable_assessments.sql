-- Enforce assessment immutability at the database level (CLAUDE.md rule 4;
-- docs/20 "defensible evidence — immutable history … records that withstand
-- institutional diligence"; docs/archive/23).
--
-- Until now, "assessments are immutable snapshots; never update a completed
-- assessment, create a new one" was enforced only by convention in the server
-- (server/scoring.ts and server/ledger.ts throw). At the data layer the
-- advisor_firm_all policy is `for all`, so a client holding an advisor JWT
-- could UPDATE or DELETE a completed, scored assessment (and its sub-scores)
-- straight through PostgREST, with no supersede record. That makes the
-- "immutable / version-controlled / defensible" claim true by habit, not by
-- guarantee. This migration makes it a guarantee.
--
-- Threat model: the untrusted path is a request carrying an end-user JWT, which
-- PostgREST runs under role `authenticated` (or `anon`). The trusted backend
-- runs as `service_role` and orchestrates corrections through supersede
-- (a new assessment); admin/superuser maintenance and offboarding also stay
-- unconstrained. So the triggers freeze completed snapshots for the end-user
-- roles only — closing the client-side tampering hole while leaving the
-- server-side supersede path, tenant offboarding, and backfills able to operate.
-- Scoring is unaffected regardless of role: it INSERTs sub-scores while the row
-- is in_progress and flips status to completed last, and INSERTs are never
-- frozen.

-- The score snapshot on the assessment itself.
create or replace function app.freeze_completed_assessment()
returns trigger
language plpgsql
as $$
begin
  -- Only end-user roles are constrained; the trusted backend and maintenance
  -- roles pass through. A completed snapshot is corrected via supersede
  -- (server-side, as service_role), never by an in-place client write.
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'completed' then
      raise exception
        'assessment % is completed and immutable; corrections supersede, never delete', old.id
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  -- UPDATE: a completed row is frozen. The completion write itself
  -- (in_progress -> completed) has old.status = 'in_progress' and passes.
  if old.status = 'completed' then
    raise exception
      'assessment % is completed and immutable; supersede it to record a correction', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger freeze_completed_assessment
  before update or delete on assessments
  for each row execute function app.freeze_completed_assessment();

-- The scored content rows (answers, sub-scores, dimension scores): frozen for
-- end-user roles once their owning assessment is completed.
create or replace function app.freeze_completed_assessment_child()
returns trigger
language plpgsql
as $$
declare
  parent_status assessment_status;
begin
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into parent_status from assessments where id = old.assessment_id;
  if parent_status = 'completed' then
    raise exception
      '% on % blocked: assessment % is completed and immutable', tg_op, tg_table_name, old.assessment_id
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger freeze_completed_child
  before update or delete on answers
  for each row execute function app.freeze_completed_assessment_child();

create trigger freeze_completed_child
  before update or delete on sub_score_results
  for each row execute function app.freeze_completed_assessment_child();

create trigger freeze_completed_child
  before update or delete on dimension_scores
  for each row execute function app.freeze_completed_assessment_child();
