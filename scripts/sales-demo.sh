#!/usr/bin/env bash
# Provision the Exit Blueprint SALES DEMO into an already-deployed (hosted)
# environment, and hand you two logins you control on the same engagement:
#
#   • an ADVISOR login  -> the full advisor workspace (/) — book of business,
#     deep-dive on the demo client, DRS, roadmap, valuation, verification.
#   • an OWNER login     -> the read-only client portal (/portal) — the same
#     engagement seen as the business owner would see it.
#
# Both point at the demo firm "Blueprint Demo Advisors" and its deep client
# "Cascade Facility Services" (two longitudinal snapshots, roadmap, valuation,
# verification, data room, engagement log, firm branding) plus a book of
# business, all produced by the existing, idempotent, firm-scoped seeds.
#
# Difference from scripts/dev-demo.sh: dev-demo boots a throwaway LOCAL Postgres
# with the dev-emulator login for `npm run dev`. THIS script provisions the same
# demo into a DB you already run (e.g. the hosted Supabase behind
# exitblueprint.net) and provisions the logins through Clerk. It never migrates,
# seeds methodology, or drops anything — the schema + rubric are assumed to be in
# place from your normal deploy. Every step is idempotent and touches only the
# demo firm, so it is safe to re-run and never reads or writes another firm.
#
# Prerequisites (hosted):
#   DATABASE_URL      service-role connection string to the deployed Postgres
#   CLERK_SECRET_KEY  sk_… so the firm/advisor/owner provision into Clerk
#                     (omit only when pointing at a local dev DB — see below)
#
# Usage:
#   DATABASE_URL=… CLERK_SECRET_KEY=… \
#     npm run demo:sales -- <advisor-email> <owner-email>
#
# Tip: route both to one inbox with a plus-alias, e.g.
#   npm run demo:sales -- you@firm.com you+owner@firm.com
#
# Optional env overrides:
#   DEMO_ADVISOR_ROLE     advisor login's app role (default: admin)
#   DEMO_PORTFOLIO_COUNT  size of the book of business (default: 15)
#   DEMO_ADVISOR_EMAIL / DEMO_OWNER_EMAIL   used if the positional args are absent
set -euo pipefail
cd "$(dirname "$0")/.."

DEMO_FIRM="Blueprint Demo Advisors"
DEMO_COMPANY="Cascade Facility Services"
ADVISOR_EMAIL="${1:-${DEMO_ADVISOR_EMAIL:-}}"
OWNER_EMAIL="${2:-${DEMO_OWNER_EMAIL:-}}"
ADVISOR_ROLE="${DEMO_ADVISOR_ROLE:-admin}"
PORTFOLIO_COUNT="${DEMO_PORTFOLIO_COUNT:-15}"

if [ -z "$ADVISOR_EMAIL" ] || [ -z "$OWNER_EMAIL" ]; then
  echo "usage: npm run demo:sales -- <advisor-email> <owner-email>" >&2
  echo "       (or set DEMO_ADVISOR_EMAIL / DEMO_OWNER_EMAIL)" >&2
  echo "the two emails must differ; a plus-alias to one inbox works, e.g." >&2
  echo "       npm run demo:sales -- you@firm.com you+owner@firm.com" >&2
  exit 1
fi
if [ "$ADVISOR_EMAIL" = "$OWNER_EMAIL" ]; then
  echo "advisor and owner emails must differ (each is a distinct login)." >&2
  echo "use a plus-alias for the owner, e.g. ${ADVISOR_EMAIL/@/+owner@}" >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required — the deployed Postgres service connection string." >&2
  exit 1
fi
if [ -z "${CLERK_SECRET_KEY:-}" ]; then
  echo "warning: CLERK_SECRET_KEY is unset — logins will provision into the LOCAL" >&2
  echo "         DEV emulator (password 'demo'), not Clerk. For a hosted sales" >&2
  echo "         demo set CLERK_SECRET_KEY so the logins provision into Clerk." >&2
fi

echo "==> 1/6  Firm + Clerk org: $DEMO_FIRM"
npm run --silent admin -- create-firm --name "$DEMO_FIRM"

echo "==> 2/6  Advisor login ($ADVISOR_ROLE): $ADVISOR_EMAIL"
npm run --silent admin -- create-advisor --firm "$DEMO_FIRM" \
  --email "$ADVISOR_EMAIL" --role "$ADVISOR_ROLE" --name "Demo Advisor"

echo "==> 3/6  Deep demo client: $DEMO_COMPANY (2 snapshots, roadmap, valuation, verification, data room)"
npm run --silent seed:demo | tail -1

echo "==> 4/6  Book of business: $PORTFOLIO_COUNT engagements"
npm run --silent seed:portfolio -- "$PORTFOLIO_COUNT" | tail -1

echo "==> 5/6  Owner login (client portal): $OWNER_EMAIL"
npm run --silent admin -- create-advisor --firm "$DEMO_FIRM" \
  --email "$OWNER_EMAIL" --role owner --name "Dana Whitfield"

echo "==> 6/6  Scope owner to the demo client: $DEMO_COMPANY"
npm run --silent admin -- assign-company --email "$OWNER_EMAIL" --company "$DEMO_COMPANY"

echo
echo "=============================================================="
echo "  Exit Blueprint sales demo provisioned"
echo "  Firm:    $DEMO_FIRM"
echo "  Client:  $DEMO_COMPANY  (+ ${PORTFOLIO_COUNT}-company book of business)"
echo
if [ -n "${CLERK_SECRET_KEY:-}" ]; then
  echo "  Advisor: $ADVISOR_EMAIL"
  echo "           sign in via Clerk (email code) -> lands on /  (advisor workspace)"
  echo "  Owner:   $OWNER_EMAIL"
  echo "           sign in via Clerk (email code) -> lands on /portal  (client view)"
  echo
  echo "  First sign-in uses Clerk's email-code / password-reset flow (per your"
  echo "  instance's enabled strategies) — no invitation email to accept."
else
  echo "  Advisor: $ADVISOR_EMAIL  /  demo   (dev emulator)  -> /"
  echo "  Owner:   $OWNER_EMAIL  /  demo   (dev emulator)  -> /portal"
fi
echo "=============================================================="
