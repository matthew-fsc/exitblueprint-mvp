-- Assessment correction workflow (S4.5 A2): supersede, never edit.
-- Assessments stay immutable in content; a correction creates a new assessment
-- and marks the old row superseded with linkage. Named record_status because
-- assessments.status already tracks the in_progress|completed lifecycle.

create type assessment_record_status as enum ('active', 'superseded');

alter table assessments
  add column record_status assessment_record_status not null default 'active',
  add column superseded_by_assessment_id uuid references assessments (id),
  add column supersede_reason text;

-- Longitudinal read path: score history, deltas, and dashboards must read
-- active assessments only (docs/02, docs/03).
create index assessments_active_by_engagement
  on assessments (engagement_id, sequence_number)
  where record_status = 'active';

create view active_assessments
  with (security_invoker = true) -- callers keep their own RLS
  as select * from assessments where record_status = 'active';

grant select on active_assessments to authenticated, service_role;
