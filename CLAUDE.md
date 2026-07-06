# Exit Blueprint Platform

Exit readiness platform for lower middle market business owners, distributed through M&A advisors. Clients are 12-36 months pre-deal. The product measures exit readiness (DRS score), diagnoses gaps, prescribes remediation playbooks, and educates owners over a long engagement.

## Non-negotiable architecture rules

1. **Deterministic scoring.** The DRS score is produced by rule-based, versioned code. No LLM ever computes, adjusts, or influences a score. Every score must be reproducible and explainable from stored answers plus rubric version.
2. **AI is narrative-only.** Claude API is used to write reports, briefs, and summaries FROM structured data. It never writes TO scoring tables. AI output is always labeled as draft narrative.
3. **Rubric lives in data, not code.** Dimensions, questions, weights, and thresholds are rows in the database (seeded from /seed). The scoring engine reads them. Changing the methodology means inserting a new rubric_version, never editing engine logic per-dimension.
4. **Engagement is the unit, not the deal.** Companies are assessed repeatedly. assessments are immutable snapshots tied to a rubric_version. Never update a completed assessment; create a new one. Score history and deltas are first-class.
5. **Multi-tenant from day one.** Every domain table carries firm_id. Supabase row-level security enforces firm isolation on all tables. No cross-firm reads, ever, except a future anonymized benchmarking layer (out of scope until explicitly requested).
6. **Versioning.** rubric_version on assessments, prompt_version on AI-generated documents, playbook_version on generated task sets.

## Stack

- Supabase (Postgres, Auth, RLS, Storage)
- React + Vite frontend (advisor workspace first, owner portal later)
- Anthropic API (Claude) for narrative generation, via a thin server-side service; never call from the browser with a key
- n8n (external, already provisioned) for scheduled workflows via webhooks; this repo only exposes the webhook endpoints n8n calls

## Working agreements for Claude Code sessions

- Build only the slice defined in the current session prompt from docs/05-build-plan.md. Do not scaffold ahead.
- Read docs/02-data-model.md before touching schema. Schema changes require a migration file, never manual edits.
- Every slice ends with: migration applied cleanly to a fresh db, seed loads, acceptance criteria from the build plan demonstrated, and a one-line entry appended to docs/06-decisions.md if any decision was made.
- Prefer boring, readable code. No abstractions for problems we don't have yet. No auth flows, billing, settings pages, or theming polish unless the slice asks for it.
- If a spec is ambiguous, stop and ask; do not invent product behavior. Product behavior decisions belong to Matthew.

## Out of scope until explicitly requested

Benchmarking analytics, billing, white-labeling, mobile apps, integrations with external financial data providers, owner-portal self-signup.
