# Seed Data - HOW TO FILL THIS IN (Matthew's Phase 0)

Everything in this folder is TEMPLATE/EXAMPLE content showing the required structure.
Replace example rows with the real DRS methodology before session S3.

1. drs-rubric.csv - the full rubric: every dimension, weight, question, answer type, and scoring map. This is the core IP. The three example questions show each pattern (select, numeric bands, scale).
2. gap-definitions.csv - every named gap with its trigger rule (see docs/03 for trigger types).
3. playbooks/ - one markdown file per playbook using the PB-CLEAN-BOOKS.md format (frontmatter + task table).
4. gap-playbook-map.csv and gap-content-map.csv - wire gaps to playbooks and education modules.
5. fixtures/ - 3 fictional companies: full answer sets plus YOUR hand-computed expected scores and expected gaps. The scoring engine is not done until it matches these exactly. Create as fixtures/company-1.json etc. with {answers: {...}, expected: {overall, dimensions: {...}, gaps: [...]}}.

Rules of thumb while writing the rubric:
- 5-8 dimensions, 6-12 questions each. Longer intakes kill advisor adoption.
- Every question must be answerable by an advisor in conversation with the owner, no document uploads required for v1.
- Every gap must map to at least one playbook and one content module, or it will flag with no prescription.
