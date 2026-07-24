-- Answer candidates: the human-in-the-loop STAGING area for AI-proposed
-- assessment answers (docs/sellside-ai WS-EXTRACT). Assessment intake is manual;
-- extraction reads a data-room document and PROPOSES candidate answers here, each
-- with a confidence and the source document/span it came from. A human then
-- confirms or rejects. THIS IS NOT A SCORING TABLE — nothing here feeds the DRS.
-- The AI writes candidate rows ONLY; a confirmed candidate is promoted to a real
-- `answers` row through the existing deterministic answer-writing path
-- (server/answer-extraction.ts confirmAnswerCandidate), so scoring stays
-- rule-based and human-gated (CLAUDE.md rules 1 & 2). The row is stamped with the
-- model + prompt_version that proposed it (rule 6).
create table answer_candidates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),          -- every domain table carries firm_id (rule 5)
  engagement_id uuid not null references engagements (id) on delete cascade,
  assessment_id uuid not null references assessments (id),
  question_code text not null,                          -- the scored question this proposes an answer for
  candidate_value jsonb not null,                       -- the proposed value (values-only, no prose)
  confidence numeric,                                   -- 0..1, model-proposed; null = not probabilistic
  source_document_id uuid references documents (id),    -- the data-room document it was extracted from
  source_span text,                                     -- where in the document (a quoted span / locator)
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  model text not null,                                  -- the model that proposed it (rule 6)
  prompt_version text not null,                         -- the prompt version that proposed it (rule 6)
  reviewed_by uuid references profiles (id),            -- who confirmed/rejected it (provenance)
  reviewed_at timestamptz
);
create index on answer_candidates (firm_id);
create index on answer_candidates (engagement_id);
create index on answer_candidates (assessment_id);

-- New tables are not covered by the historical all-tables grant; grant explicitly.
-- Staff review the queue and confirm/reject, so select+insert+update (a candidate
-- is superseded by status, never hard-deleted from the client).
grant select, insert, update on answer_candidates to authenticated;
grant all on answer_candidates to service_role;

alter table answer_candidates enable row level security;

-- Firm staff (advisor/reviewer/admin) read + write their own firm's candidates.
-- The insert check also confirms the target engagement belongs to that firm, so a
-- candidate can never be staged against another firm's engagement.
create policy staff_firm_all on answer_candidates for all to authenticated
  using (app.user_role() = any (array['advisor', 'reviewer', 'admin']::app_role[])
         and firm_id = app.user_firm_id())
  with check (
    app.user_role() = any (array['advisor', 'reviewer', 'admin']::app_role[])
    and firm_id = app.user_firm_id()
    and exists (select 1 from engagements e where e.id = engagement_id and e.firm_id = firm_id)
  );
