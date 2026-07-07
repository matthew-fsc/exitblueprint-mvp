# Exit Blueprint

Exit readiness platform for lower middle market business owners, distributed
through M&A advisors. See `docs/00-product-brief.md` and `CLAUDE.md` for the
product and architecture ground rules.

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

## Layout

```
src/                 React app (health page; advisor workspace comes in Phase 2)
shared/scoring/      pure, deterministic scoring engine (no I/O)
server/              db-backed engine entry points (scoreAssessment, explainAssessment)
scripts/             migrate / seed / RLS test / dev db
supabase/migrations/ schema + RLS (the only way schema changes happen)
db/supabase-shim.sql plain-Postgres stand-in for Supabase auth schema/roles
seed/                rubric, gap definitions, playbooks, fixtures (source of truth)
docs/                specs; build plan in docs/05-build-plan.md
```
