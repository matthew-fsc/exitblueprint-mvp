#!/usr/bin/env bash
# Run the RLS firm-isolation suite against a CLEAN, migrated-but-UNSEEDED
# throwaway database.
#
# Why a separate DB: scripts/rls-test.ts assumes it runs BEFORE db:seed — it
# seeds its own data-room template rows (e.g. data_room_sections 'FIN'), which
# collide with the methodology seed. CI avoids this by ordering (test:rls before
# seed) on a throwaway database. The bootstrapped dev DB is migrated + seeded so
# `npm test` and the app work, so test:rls needs its own clean DB. This mirrors
# CI exactly without touching the dev DB.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

PGPORT="${PGPORT:-55499}"
BASE="postgresql://postgres@127.0.0.1:$PGPORT"
RLSDB="${EB_RLS_DB:-exit_blueprint_rls}"

psql "$BASE/postgres" -v ON_ERROR_STOP=1 -c "drop database if exists $RLSDB" >/dev/null
psql "$BASE/postgres" -v ON_ERROR_STOP=1 -c "create database $RLSDB" >/dev/null

export DATABASE_URL="$BASE/$RLSDB"
npm run --silent db:migrate >/dev/null
exec npm run --silent test:rls
