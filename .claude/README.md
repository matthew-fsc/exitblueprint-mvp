# `.claude/` — shared agent infrastructure

Checked-in tooling that gets every Claude Code session productive fast and
consistent with this repo's rules. Local skill/plugin installs under `.claude/`
stay git-ignored (see `.gitignore`); only the files listed here are committed.

## What's here

| Path | What it does |
|---|---|
| `settings.json` | Wires the SessionStart hook and a permission allowlist for the definition-of-done + safe dev/git commands (fewer prompts). |
| `hooks/session-start.sh` | Runs at session start. Persists the deterministic local `DATABASE_URL` for every shell, backgrounds the DB bootstrap, and injects orientation context (rules, docs map, definition of done). |
| `hooks/bootstrap-db.sh` | Idempotent "make it test-ready": deps + local Postgres + migrate + seed. Runs backgrounded by the hook, or foreground via `/db-up`. |
| `hooks/test-rls.sh` | Runs `test:rls` against a clean throwaway DB. `rls-test.ts` assumes it runs *before* `db:seed` (it seeds its own data-room rows), so it can't run against the seeded dev DB; this wrapper mirrors CI's ordering without touching it. |
| `commands/dod.md` | `/dod` — run the full definition-of-done gate and report PASS/FAIL. |
| `commands/db-up.md` | `/db-up` — force DB readiness now and confirm. |

## How a fresh session comes up

1. SessionStart exports `DATABASE_URL` + `EB_PARSER=fixture` for new shells and
   starts `bootstrap-db.sh` in the background.
2. The DB is ready when `/tmp/eb-bootstrap.done` exists (log:
   `/tmp/eb-bootstrap.log`). Run `/db-up` to block until ready.
3. Orientation (CLAUDE.md rules, `docs/README.md` code map, `docs/27` + `templates/`,
   definition of done) is injected into the agent's context automatically.

Nothing here changes app behavior, scoring, schema, or RLS — it's session
ergonomics only. To adjust setup, edit `bootstrap-db.sh`; to change what runs at
start or which commands are pre-approved, edit `settings.json`.
