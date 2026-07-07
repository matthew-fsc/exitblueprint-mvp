-- S8: owner report edit-before-finalize. Drafts are editable; finalizing
-- stamps finalized_at (content stays editable history-wise via new rows if
-- ever needed — v1 keeps one row per generated document).
alter table generated_documents
  add column finalized_at timestamptz;
