# 08 - Operations

## Environments

Three Supabase projects:

| Env | Purpose | Selected by |
|---|---|---|
| local | development | `supabase start` (or `scripts/devdb.sh` without Docker); `DATABASE_URL` points at the local db |
| staging/demo | advisor demos, pilot rehearsal | deployed env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, server `DATABASE_URL`) for the staging project |
| production | live client data | same variables, production project |

- Migrations flow local → staging → production, always via files in
  `supabase/migrations/` (`npm run db:migrate` or `supabase db push`). Never
  edit schema by hand in any environment.
- `npm run db:seed` (rubric/methodology) runs in every environment.
- `npm run seed:demo` (demo tenant) runs on staging/demo only by default. It is
  firm-scoped and idempotent, but production hosts no demo firm.

## Provisioning (CLI-only through MVP)

Firms, advisors, and owner-company assignment are provisioned with
`scripts/admin.ts` using the server-side database connection — there is no
admin UI until explicitly promoted:

```sh
npm run admin -- create-firm --name "Summit Exit Advisors"
npm run admin -- create-advisor --firm "Summit Exit Advisors" --email jo@summit.com --role advisor --name "Jo Advisor"
npm run admin -- assign-company --email owner@client.com --company "Client Co"
```

`create-advisor` provisions the auth user + profile rows; login credentials are
issued via the Supabase dashboard/auth invite (S5 wires the login flow).

## Secrets

- Local: `.env` (untracked; `.env.example` is the template).
- Deployed: the hosting provider's secret store (Supabase function secrets /
  platform env vars). Never committed.
- The service-role key and `DATABASE_URL` are server-side only — never in the
  client bundle. The browser sees only `VITE_SUPABASE_URL` + the anon key.
- The Anthropic API key lives server-side only (edge function secret), per
  CLAUDE.md; the browser never sees it.

## Backups

- Production: enable Supabase scheduled backups and PITR (Dashboard → Database
  → Backups) before the first live client.
- Restore procedure: Supabase Dashboard → Backups → Restore; document the
  runbook link here once the production project exists.

## Data handling one-pager (advisor-facing) — DRAFT for Matthew's review

> Draft language. Statements marked [ratify] need Matthew's sign-off before
> this is shown to any advisor or client. Do not treat as legal commitments.

- **Where client data is stored:** in our database hosted by Supabase in
  [region — set when the production project is created; ratify]. Data is
  encrypted in transit and at rest by the hosting platform.
- **Who can access it:** your firm's advisors, and the business owner for
  their own company. Access is enforced at the database row level (row-level
  security): no firm can read another firm's data, ever. Platform
  administration happens through controlled server-side access, not through
  user accounts. [ratify: internal access policy wording]
- **What the AI layer sees:** the report-writing service receives structured
  outputs — scores, gap names, and the explanation trace — to draft narrative
  documents. It never computes or changes any score. Client data is not used
  to train AI models. [ratify: confirm current Anthropic API data-use terms
  are reflected accurately at time of publication]
- **Deletion requests:** send them to your advisor or to us directly; we
  delete the company's data from the live database and it ages out of backups
  on the backup retention schedule. [ratify: retention window and any
  regulatory carve-outs]
