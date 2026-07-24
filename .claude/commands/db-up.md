---
description: Bring the local database up now — deps, Postgres, migrations, seed — and confirm it is test-ready.
allowed-tools: Bash(bash .claude/hooks/bootstrap-db.sh:*), Bash(source .claude/.session-env:*), Bash(bash .claude/hooks/test-rls.sh:*)
---

Make this checkout test-ready NOW (blocking), then confirm.

1. Run `bash .claude/hooks/bootstrap-db.sh` (idempotent: installs deps if
   missing, starts local Postgres, applies migrations, seeds methodology).
2. Run `source .claude/.session-env` so `DATABASE_URL` is set in this shell.
3. Sanity-check with `bash .claude/hooks/test-rls.sh` (firm isolation on a clean
   throwaway DB) and report whether it passes.

Report the final `DATABASE_URL` and readiness. If PostgreSQL server binaries
aren't available, say so and tell me to point `DATABASE_URL` at another database.
