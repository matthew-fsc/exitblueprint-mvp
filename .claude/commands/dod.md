---
description: Run the definition-of-done gate (build, tests, RLS, fresh-DB migrate+seed, eval) and report pass/fail.
---

Run the ExitBlueprint definition of done from CLAUDE.md and report a clear
PASS/FAIL for each gate. First make sure the database is up (if
`/tmp/eb-bootstrap.done` is missing, run `bash .claude/hooks/bootstrap-db.sh`
and `source .claude/.session-env`).

Run these and summarize results — do not guess, run them:

1. `npm run build` — tsc typecheck + vite build.
2. `npm test` — vitest; the scoring engine MUST still reproduce seed/fixtures exactly (architecture rule #1). Runs against the bootstrapped (migrated + seeded) dev DB.
3. `bash .claude/hooks/test-rls.sh` — firm isolation (rule #5). Use this wrapper, NOT bare `npm run test:rls`: rls-test needs a clean, unseeded DB (it seeds its own data-room rows), so the wrapper runs it against a throwaway DB, exactly like CI.
4. Fresh-DB proof: on a clean database, `npm run db:migrate && npm run db:seed` applies clean (the bootstrap already proved this for the dev DB).
5. `npm run eval` — ONLY if this branch touched the AI / narrative layer (`server/narrative.ts`, `server/intelligence/*`, prompts, evals). Say "skipped — no AI-layer changes" otherwise.

Then confirm the build-plan acceptance criteria for the slice are demonstrated,
and remind me to append a one-line entry to `docs/06-decisions.md` if a decision
was made. Report the failing gate's output verbatim if anything fails.
