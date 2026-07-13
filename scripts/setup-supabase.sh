#!/usr/bin/env bash
# One-command production database stand-up (docs/10-production-readiness.md, Phase 1;
# docs/11-deploy-runbook.md). Applies the migrations, proves firm isolation (RLS),
# and seeds the methodology against DATABASE_URL — the same sequence CI runs, and
# the same one rehearsed against a fresh database.
#
# Point DATABASE_URL at the target project first (keep the password in your shell,
# never in source):
#
#   DATABASE_URL="postgresql://postgres:[PW]@db.<ref>.supabase.co:5432/postgres" \
#     npm run db:setup
#
# Use a SESSION-mode connection string (direct :5432 or the Session pooler :5432).
# The Transaction pooler (:6543) cannot run migrations.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set. Export the target connection string first." >&2
  echo "See docs/11-deploy-runbook.md." >&2
  exit 1
fi

# Show the host being targeted, but never the password.
host=$(printf '%s' "$DATABASE_URL" | sed -E 's#^.*@([^/]+)/.*#\1#')
echo "==> Target: ${host}"

echo "==> [1/3] Applying migrations"
npm run db:migrate

echo "==> [2/3] Proving firm isolation (RLS) — runs in a rolled-back transaction, leaves no data"
npm run test:rls

echo "==> [3/3] Seeding methodology (rubric, dimensions, valuation rules)"
npm run db:seed

echo "==> Done. Database is migrated, RLS-verified, and seeded."
echo "    Next: deploy the compute service (server/http.ts) and the frontend — see the runbook."
