-- Two more sell-side deliverables the advisor takes to market alongside the CIM:
--   * teaser: the anonymized "blind profile" circulated to the buyer universe
--     before an NDA is signed, and
--   * management_presentation: the management-meeting narrative that follows the
--     CIM, behind an NDA.
-- Additive — extends the doc_type enum; no data change, no new table. Both reuse
-- generated_documents, so the existing RLS applies unchanged:
--   * advisor_firm_all grants staff full CRUD on their firm's rows (both are
--     advisor-controlled deliverables), and
--   * owner_report_read restricts owners to doc_type = 'owner_report' (plus the
--     finalized-CIM carve-out), so neither the teaser nor the management
--     presentation is ever readable in the owner portal — which is what we want
--     for buyer-facing market documents the advisor controls.
-- (PG12+ permits ADD VALUE inside a transaction, which is how scripts/migrate.ts
-- applies each migration.)
alter type doc_type add value if not exists 'teaser';
alter type doc_type add value if not exists 'management_presentation';
