#!/usr/bin/env bash
# One-command demo boot: local Postgres, migrations, methodology seed, demo
# tenant, demo advisor login, then the Vite dev server (with the built-in
# Supabase dev emulator). Used by `npm run dev:demo` and the Codespaces
# devcontainer. Pass --background to start Vite detached (devcontainer mode).
set -euo pipefail
cd "$(dirname "$0")/.."

# Find Postgres binaries (any installed major version).
export PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [ -z "${PGBIN}" ] || [ ! -x "${PGBIN}/initdb" ]; then
  echo "PostgreSQL not found. Install it (apt-get install postgresql) or use 'supabase start'." >&2
  exit 1
fi

[ -d node_modules ] || npm ci

DATABASE_URL=$(bash scripts/devdb.sh | grep '^DATABASE_URL=' | cut -d= -f2-)
export DATABASE_URL
echo "database: $DATABASE_URL"

# Sell-side verification uses the fixture parser in the demo so uploaded fixture
# documents extract and "Run verification" produces the populated tab.
export EB_PARSER="${EB_PARSER:-fixture}"

npm run --silent db:migrate
npm run --silent db:seed | tail -1
npm run --silent seed:demo | tail -1
# Demo advisor for the demo firm (created by seed:demo). Idempotent.
# (No truncating pipe here: closing the CLI's stdout early causes an EPIPE
# that would abort the boot under pipefail.)
npm run --silent admin -- create-advisor --firm "Blueprint Demo Advisors" \
  --email demo@blueprintdemo.test --name "Demo Advisor"

echo
echo "=============================================================="
echo "  Exit Blueprint demo is ready"
echo "  Sign in:  demo@blueprintdemo.test  /  demo"
echo "=============================================================="
echo

if [ "${1:-}" = "--background" ]; then
  VITE_LOG="${TMPDIR:-/tmp}/exitblueprint-vite-$(id -u).log"
  nohup npx vite --host > "$VITE_LOG" 2>&1 &
  echo "Vite dev server starting in the background on port 5173 (log: $VITE_LOG)"
else
  exec npx vite --host
fi
