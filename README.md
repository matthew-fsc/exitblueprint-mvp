# Exit Blueprint

[![Open demo in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/matthew-fsc/exitblueprint-mvp?quickstart=1)

Exit readiness platform for lower middle market business owners, distributed
through M&A advisors. See `docs/00-product-brief.md` and `CLAUDE.md` for the
product and architecture ground rules.

## Instant demo

**One click (in the browser):** press the Codespaces badge above. GitHub boots
a dev container that installs everything, seeds the demo tenant, and starts
the app; a browser tab opens on the forwarded port when it's ready (first boot
takes a couple of minutes; later boots are fast).

**One command (on your machine, needs Node 22 + PostgreSQL):**

```sh
npm run dev:demo
```

Either way, sign in with **demo@blueprintdemo.test** / **demo** — the demo
firm has Cascade Facility Services mid-journey with two scored assessments
(59.9 Needs Work → 72.3 Sale Ready), so the intake, results, explain drawer,
and owner report views all have real data. This dev stack runs the built-in
Supabase emulator with real RLS; it accepts the fixed password 'demo' and is
for demos and development only.

## Stack

- Supabase (Postgres, Auth, RLS) — single source of truth
- React + Vite + TypeScript (advisor workspace first)
- Deterministic scoring engine (`shared/scoring`), rubric seeded from `/seed`

## Local development

```sh
npm install
supabase start          # full local stack (requires Docker)
npm run db:migrate      # apply supabase/migrations
npm run db:seed         # load /seed rubric, playbooks, content
npm run dev             # Vite dev server (health page at /)
npm test                # scoring engine + fixture tests
npm run test:rls        # firm-isolation RLS proof
```

Copy `.env.example` to `.env`; `supabase start` prints the URL/keys.

### Without Docker (restricted environments, CI)

`scripts/devdb.sh` starts a plain Postgres 16 cluster and prints a
`DATABASE_URL`. `npm run db:migrate` detects plain Postgres and first applies
`db/supabase-shim.sql` (auth schema, `auth.uid()`, Supabase roles) so the same
migrations run unmodified. CI uses this path with a `postgres:16` service.

### Seeding a hosted deployment (methodology from inside the system)

A hosted deploy ships only the frontend/compute code — it does **not** run the
seed, so a fresh Supabase project has the schema but no methodology (starting an
assessment fails with "no active rubric version"). Rather than run the CLI with a
production connection string, load it from inside the system:

1. On the compute service, set `PLATFORM_SUPERADMIN_IDS` to the Clerk user id(s)
   allowed to publish methodology (comma-separated), and redeploy so the image
   ships `/seed` (`server/Dockerfile`).
2. Sign in as that user and open `/health`. When no active rubric exists, a
   **Load methodology** button appears — it calls the superadmin-gated
   `seed-methodology` function, which runs the same validated, idempotent
   pipeline as `npm run db:seed` (`server/seed-methodology.ts`) with the
   service-role client, and shows the per-table report.

The CLI (`npm run db:seed`) remains the path for local dev and CI.

## Layout

```
src/                 React app (health page; advisor workspace comes in Phase 2)
shared/scoring/      pure, deterministic scoring engine (no I/O)
server/              db-backed engine entry points (scoreAssessment, explainAssessment)
scripts/             migrate / seed / RLS test / dev db
supabase/migrations/ schema + RLS (the only way schema changes happen)
db/supabase-shim.sql plain-Postgres stand-in for Supabase auth schema/roles
seed/                rubric, gap definitions, playbooks, fixtures (source of truth)
docs/                specs; start at docs/README.md (index) — roadmap in docs/05-build-plan.md
```
