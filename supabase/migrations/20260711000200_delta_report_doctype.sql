-- F4: the branded delta report is a new generated document type. Additive —
-- extends the doc_type enum; no data change. (PG12+ permits ADD VALUE inside a
-- transaction, which is how scripts/migrate.ts applies each migration.)
alter type doc_type add value if not exists 'delta_report';
