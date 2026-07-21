-- Let owners read the CIM for their own engagement — but only once the advisor
-- has FINALIZED it (Matthew, 2026-07-21: "the owner should be allowed to").
--
-- The CIM is a buyer-facing marketing document that auto-generates an unreviewed
-- AI draft the moment an advisor opens its tab, and the standing guardrail is
-- that the advisor reviews it before it is shared (docs/17). So the owner's read
-- is gated on finalized_at: an in-progress draft stays private to the firm, and
-- the owner sees the memorandum only after the advisor signs off on it.
--
-- Additive alongside owner_report_read (which is unchanged and un-gated — the
-- owner report is the owner's own diagnostic, theirs to see anytime).
-- Collaborators are deliberately left owner_report-only, so the invariant
-- "a collaborator sees a strict subset of what the owner sees" still holds.
create policy owner_cim_read on generated_documents for select to authenticated
  using (
    app.user_role() = 'owner'
    and doc_type = 'cim'
    and finalized_at is not null
    and engagement_id in (
      select e.id from engagements e where e.company_id = app.user_company_id()
    )
  );
