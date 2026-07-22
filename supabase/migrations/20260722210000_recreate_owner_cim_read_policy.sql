-- Recreate the owner_cim_read RLS policy (originally authored in
-- 20260721000600_owner_cim_visibility.sql), which lets an owner read their own
-- engagement's CIM once the advisor has FINALIZED it.
--
-- Why it can be missing. That original file shares its 14-digit version prefix
-- (20260721000600) with 20260721000600_firm_service_tier.sql — a cross-branch
-- timestamp collision, the exact parallel-work hazard CLAUDE.md warns about.
-- `supabase db push` keys migrations on that version, so on a db-push-provisioned
-- database only the first-sorting file (firm_service_tier) registered the version
-- and owner_cim_visibility was SILENTLY SKIPPED — leaving owners unable to read
-- their finalized CIM. (firm_service_tier itself was later dropped in
-- 20260722000500, so only the owner_cim_read policy is the casualty.)
--
-- Fix forward under a unique version rather than touching the already-applied
-- colliding file. Idempotent: drop-if-exists then create, so this is a safe no-op
-- on databases where the original DID apply (fresh `db:migrate`, dashboard-seeded
-- DBs) and creates the policy where it was skipped. Definition is verbatim from the
-- original; the referenced objects (generated_documents.doc_type / finalized_at /
-- engagement_id, app.user_role(), app.user_company_id()) are all still current.
drop policy if exists owner_cim_read on generated_documents;
create policy owner_cim_read on generated_documents for select to authenticated
  using (
    app.user_role() = 'owner'
    and doc_type = 'cim'
    and finalized_at is not null
    and engagement_id in (
      select e.id from engagements e where e.company_id = app.user_company_id()
    )
  );
