#!/usr/bin/env bash
# Make a fresh checkout test-ready: install deps, start a local Postgres, apply
# migrations, seed methodology. Idempotent — safe to run repeatedly.
#
# Run automatically (backgrounded) by the SessionStart hook, and on demand via
# the /db-up slash command. This is the same DB path scripts/dev-demo.sh uses,
# minus the Vite server and demo tenant — just what the definition-of-done gates
# (npm run db:migrate / db:seed / test:rls) need.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

DONE="${TMPDIR:-/tmp}/eb-bootstrap.done"
rm -f "$DONE"

# 1. Dependencies (skip if already installed — npm ci is the slow part).
if [ ! -d node_modules ]; then
  echo "eb-bootstrap: installing dependencies (npm ci)…"
  npm ci
fi

# 2. Local Postgres — reuse any installed major version. Missing server binaries
#    is not fatal: deps are still installed and the agent can point DATABASE_URL
#    at another database.
export PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [ -n "${PGBIN}" ] && [ -x "${PGBIN}/initdb" ]; then
  DATABASE_URL="$(bash scripts/devdb.sh | grep '^DATABASE_URL=' | cut -d= -f2-)"
  export DATABASE_URL
  export EB_PARSER="${EB_PARSER:-fixture}"
  echo "eb-bootstrap: database $DATABASE_URL"

  # 3. Schema + methodology. Both are idempotent (migrate applies only pending
  #    files; seed upserts), so re-runs are cheap no-ops.
  npm run --silent db:migrate
  npm run --silent db:seed | tail -1
else
  echo "eb-bootstrap: no PostgreSQL server binaries found — skipping DB setup." >&2
  echo "eb-bootstrap: set DATABASE_URL yourself to run the DB-backed suites." >&2
fi

touch "$DONE"
echo "eb-bootstrap: ready"
