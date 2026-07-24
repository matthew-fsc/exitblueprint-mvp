# Exit Blueprint Platform

Exit readiness platform for lower middle market business owners, distributed through M&A advisors. Clients are 12-36 months pre-deal. The product measures exit readiness (DRS score), diagnoses gaps, prescribes remediation playbooks, and educates owners over a long engagement.

## About this file

This is the always-loaded contract read by every agent on every turn. Keep it small and stable: invariants, scope, and pointers only. Feature detail and "what shipped when" live in `docs/` (find them via docs/README.md) — do not inline them here. If you're tempted to add a paragraph about a feature or a changelog line, it belongs in a doc, not in this file.

## Non-negotiable architecture rules

Each rule names how it is verified. If a task appears to require violating one of these, **stop and ask** — do not reinterpret the rule to fit the task.

1. **Deterministic scoring.** The DRS is produced by rule-based, versioned code: questions capture inputs, sub_scores compute and band derived metrics, dimensions weight sub-scores, DRS weights the six business dimensions. No LLM ever computes, adjusts, or influences a score. The executable reference implementation is seed/fixtures/reference_scorer.py; the engine is correct when it reproduces the fixture outputs exactly (`npm test`).
2. **AI is narrative-only.** Claude API is used to write reports, briefs, and summaries FROM structured data. It never writes TO scoring tables. AI output is always labeled as draft narrative.
3. **Rubric lives in data, not code.** Dimensions, questions, sub-scores, weights, bands, and thresholds are rows in the database (seeded from /seed, which is canonical methodology, not placeholder). Changing the methodology means inserting a new rubric_version, never editing engine logic per-dimension.
3a. **Two score groups, never mixed.** business_readiness dimensions roll into the DRS; owner_readiness dimensions roll into the separate Owner Readiness Index (ORI). See docs/07-drs-methodology.md.
4. **Engagement is the unit, not the deal.** Companies are assessed repeatedly. assessments are immutable snapshots tied to a rubric_version. Never update a completed assessment; create a new one. Score history and deltas are first-class.
5. **Multi-tenant from day one.** Every domain table carries firm_id. Supabase row-level security enforces firm isolation on all tables. No cross-firm reads, ever, except a future anonymized benchmarking layer (out of scope until explicitly requested). Firm isolation is verified by `npm run test:rls`, not by inspection.
6. **Versioning.** rubric_version on assessments, prompt_version on AI-generated documents, playbook_version on generated task sets.

## Stack

- Supabase (Postgres, RLS, Storage) + Clerk (Auth). **Clerk is the standard identity provider**; RLS validates Clerk JWTs via JWKS (Clerk = Organizations→firms). Firms/advisors are provisioned into Clerk automatically by `scripts/admin.ts` (create-firm → Clerk Organization; create-advisor → Clerk user + membership + profile). Auth is config-gated: unset `VITE_CLERK_PUBLISHABLE_KEY` selects the **local dev emulator only** (local/CI). The hosted Supabase-Auth login was removed; a hosted deploy without Clerk is unsupported (docs/30).
- React + Vite frontend (advisor workspace first, owner portal later)
- Anthropic API (Claude) for narrative generation, via a thin server-side service; never call from the browser with a key
- n8n (external, already provisioned) for scheduled workflows via webhooks; this repo only exposes the webhook endpoints n8n calls

## Working agreements for Claude Code sessions

- **Session bootstrap: `.claude/`** — a SessionStart hook installs deps and brings up a local Postgres (migrate + seed) in the background, and exports `DATABASE_URL` for you. Run `/db-up` to block until it's ready, `/dod` to run the definition-of-done gate. See `.claude/README.md`.
- **Docs index: docs/README.md** — start there to find the right doc; it labels each as Canonical / Reference / Strategy / Runbook / Log and lists what's been archived. The feature→file map lives there, not here.
- Build only the slice defined in the current session prompt from docs/05-build-plan.md. Do not scaffold ahead.
- **Follow the established patterns.** Before adding a table, function, hook, module, or page, read docs/27-engineering-patterns.md and copy the matching skeleton from templates/. UI follows docs/26-ui-system.md (tokens/components/format helpers — never raw snake_case, raw integers, ad-hoc labels, or hand-rolled tables).
- Read docs/02-data-model.md before touching schema. Schema changes require a migration file, never manual edits.
- Prefer boring, readable code. No abstractions for problems we don't have yet. No auth flows, billing, settings pages, or theming polish unless the slice asks for it.
- If a spec is ambiguous, stop and ask; do not invent product behavior. Product behavior decisions belong to Matthew.

## Working in parallel (multiple agents / branches)

The codebase is large and several agents may be building at once. Avoid the ways parallel work collides:

- **One branch per build-plan slice.** Before starting, check open branches/PRs so two agents don't build the same slice. Never push to another agent's branch. Open a PR when your branch has no open one.
- **Never hand-allocate a sequential number** — it races across branches. Migration filenames use a full UTC timestamp taken at creation (`YYYYMMDDHHMMSS_name.sql`), never a hand-picked `...000100 / ...000200` sequence. Doc numbers are assigned by Matthew and never auto-incremented or reused (a past collision put two docs at number 37).
- **High-contention files — union-merge, never overwrite.** These are touched by nearly every slice, so expect conflicts and resolve by keeping **both** sides: `docs/06-decisions.md` (append your entry at the very end), `docs/README.md` (feature→file map), `docs/28-architecture-map.md`, `src/styles.css`, and the nav. On any append-only log, the resolution is always "keep both entries," never "pick one."

## Definition of done (run these, don't guess)

Every slice ends with all of the following passing, plus the acceptance criteria from the build plan demonstrated:

- `npm run build` — tsc typecheck + vite build must pass
- `npm test` — vitest; the scoring engine must still reproduce seed/fixtures exactly (rule #1)
- `npm run test:rls` — firm isolation (rule #5) is verified here
- Fresh DB: `npm run db:migrate && npm run db:seed` applies clean from an empty database
- `npm run eval` — only if you touched the AI / narrative layer
- Append a one-line entry to docs/06-decisions.md if any decision was made

## Out of scope until explicitly requested

Benchmarking analytics, mobile apps, integrations with external financial data providers, owner-portal self-signup, consumer communication channels.

Current scope and what has shipped so far live in **docs/05-build-plan.md** (roadmap) and **docs/06-decisions.md** (log) — read those rather than tracking status here.
