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
- **In-system self-service (hosted).** The superadmin "Load methodology" button
  on `/health` (the `seed-methodology` function) applies any **pending migrations
  first**, then seeds — so a hosted beta can bring both schema and methodology
  current without anyone running the CLI against a production connection string.
  Idempotent (migrations tracked in `public.schema_migrations`, run at most once);
  the shared runner is `server/migrate.ts` (the CLI `db:migrate` wraps the same
  logic). This is why `server/Dockerfile` ships `supabase/migrations/` into the
  compute image. It complements, and does not replace, the CLI/`db push` flow above.
- `npm run db:seed` (rubric/methodology) runs in every environment.
- `npm run seed:demo` (demo tenant) runs on staging/demo only by default. It is
  firm-scoped and idempotent, but production hosts no demo firm.

## Provisioning (CLI + Clerk webhook)

Firms, advisors, and owner-company assignment are provisioned with
`scripts/admin.ts` using the server-side database connection:

```sh
npm run admin -- create-firm --name "Summit Exit Advisors"
npm run admin -- create-advisor --firm "Summit Exit Advisors" --email jo@summit.com --role advisor --name "Jo Advisor"
npm run admin -- assign-company --email owner@client.com --company "Client Co"
```

**Identity is Clerk** (`docs/30`). With `CLERK_SECRET_KEY` set, `create-firm`
provisions a Clerk **Organization** and `create-advisor` provisions the Clerk
**user + membership** alongside the profile rows; login/MFA/invites all run
through Clerk. Firms and advisors can also self-provision via the Clerk webhook
(`POST /webhooks/clerk`, `server/clerk-webhook.ts`) on Clerk events. Unset
`CLERK_SECRET_KEY` selects the local dev path (`auth.users`) for seeding only.

## Secrets

- Local: `.env` (untracked; `.env.example` is the template).
- Deployed: the hosting provider's secret store (Supabase function secrets /
  platform env vars). Never committed.
- The service-role key and `DATABASE_URL` are server-side only — never in the
  client bundle. The browser sees only `VITE_`-prefixed values (`VITE_SUPABASE_URL`
  + anon key, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_FUNCTIONS_URL`). Full env
  catalog: `.env.example` and `docs/14-environment-keys.md`.
- The Anthropic API key lives server-side only (edge function secret), per
  CLAUDE.md; the browser never sees it.

## Backups & recovery

The production database is the only irreplaceable asset (client financials,
assessments, score history). This section is the restore runbook — read it once
before the first live client, and follow it exactly when recovering. Everything
in "Enable" and "Restore" is an **operator action requiring production access**
(Supabase dashboard for the prod project + the host secret stores); nothing here
can be driven from the repo.

### Enable (do once, before the first live client) — operator action

1. Supabase Dashboard → the **production** project → **Database → Backups**.
2. Confirm **scheduled daily backups** are on. Daily snapshots are included on
   Pro and above; on the free tier they are not — a paid tier is required for
   any backup guarantee. `[confirm]` production is on a tier that includes daily
   backups (docs/29 Step 1.7 turns this on).
3. Enable **Point-in-Time Recovery (PITR)** on the same page. PITR is a paid
   add-on that streams WAL so you can restore to any second within the retention
   window, not just to a nightly snapshot.
4. Record the two retention windows for this project (they differ by tier and by
   add-on): daily-snapshot retention `[confirm]` (Pro default is 7 days) and PITR
   retention `[confirm]` (add-on default is 7 days, extendable). These bound how
   far back a restore can reach — write the actual values here once set.

### RPO / RTO expectations

| Metric | Target | Basis |
|---|---|---|
| **RPO** (max data loss) | ≤ ~2 min with PITR on; up to 24 h on nightly snapshots alone | PITR replays WAL to a chosen second; without it the last nightly snapshot is the floor. Exact PITR granularity is tier-dependent — `[confirm]` |
| **RTO** (time to restored, reachable DB) | ~30–60 min end-to-end `[confirm]` | Supabase restore duration scales with DB size (`[confirm]` against a real restore drill) + the manual reconnect/validation steps below |
| Retention (how far back you can restore) | Snapshot: `[confirm]` · PITR: `[confirm]` | Set in "Enable" step 4 |

These are targets, not guarantees. The only way to trust the RTO number is to
run one restore drill against a throwaway restore target and time it — do that
before the first live client and record the measured RTO here.

### Restore procedure — operator action

Two flavours; both start in Supabase Dashboard → the affected project →
**Database → Backups**.

**A. Restore from a nightly snapshot**

1. **Backups → Scheduled backups**, pick the snapshot to restore, click
   **Restore**. Confirm the destructive-action prompt (a restore **overwrites**
   the current database state).
2. Wait for Supabase to report the restore complete. The project keeps the same
   **ref**, so `VITE_SUPABASE_URL`, `DATABASE_URL` host, and the anon/service
   keys are unchanged — no host env edits needed for an in-place restore.

**B. Restore to a point in time (PITR)**

1. **Backups → Point in Time**, choose the target timestamp (UTC — convert
   carefully; an off-by-one-hour target is a common miss). Pick the last known
   good moment *before* the data-loss event.
2. Confirm and wait for completion, same overwrite semantics as A.

**After either restore — where secrets come from**

- **In-place restore (same project ref):** no secret changes. `DATABASE_URL`,
  `SUPABASE_URL`/`VITE_SUPABASE_URL`, anon key, and `SUPABASE_SERVICE_ROLE_KEY`
  on Render/Vercel already point at this project (docs/29 env table). The keys
  survive a restore.
- **Restore into a NEW project** (if you chose to restore to a fresh project
  ref rather than overwrite — e.g. to inspect before cutting over): the ref
  changes, so **every** connection string and key changes. Re-pull them per
  docs/29 Step 1 (Project URL → `VITE_SUPABASE_URL`, service_role key,
  `DATABASE_URL` session-pooler string) and update them on Render and Vercel,
  then **redeploy Vercel** so the new `VITE_*` values are inlined. Confirm
  Clerk third-party auth is configured on the new project too (docs/30 §2 /
  docs/31) or every read fails as `anon`.
- Non-DB secrets (`EB_DOCUMENT_KEY`, `ANTHROPIC_API_KEY`, Clerk/Stripe keys)
  live in the host stores, not the database, so a DB restore never touches them.
  `[confirm]` `EB_DOCUMENT_KEY` is unchanged — documents encrypted with a
  different key than the restored rows reference will not decrypt.

### Post-restore validation checklist

Run these against the restored database (set `DATABASE_URL` to the restored
project's connection string) before pointing live traffic at it. All four use
real repo scripts / queries:

1. **Firm isolation still holds** — `DATABASE_URL="…restored…" npm run test:rls`.
   This is the go/no-go: it runs the full RLS isolation suite in a rolled-back
   transaction (leaves no data) and must report **0 failed**. A restore that
   silently dropped a policy or role fails here.
2. **The active rubric resolves** — the app reads scoring methodology via the
   single `status = 'active'` rubric version (`loadActiveRubricVersion()` in
   `src/lib/rubric.ts`). Confirm exactly one exists:
   ```sh
   psql "$DATABASE_URL" -c \
     "select version_label, status from rubric_versions where status = 'active';"
   ```
   Exactly one row. Zero rows means scoring is dead (the app throws
   "no active rubric version — run npm run db:seed"); more than one is a data
   integrity problem to investigate before going live.
3. **Seed is idempotent against the restored data** —
   `DATABASE_URL="…restored…" npm run db:seed`. On an intact restore this should
   report **0 inserted / 0 updated** for the rubric tables (everything already
   present) and exit 0. Non-zero inserts mean the restore is missing methodology
   rows — investigate before serving clients. (Seeding is safe: the pipeline is
   upsert-only and writes only methodology tables, never client data.)
4. **Spot-check firm isolation with real data** — as a sanity check beyond the
   synthetic rls-test fixtures, confirm client rows actually came back and are
   firm-scoped:
   ```sh
   psql "$DATABASE_URL" -c "select count(*) from companies;"          -- expect > 0
   psql "$DATABASE_URL" -c "select count(distinct firm_id) from companies;"
   ```
   Then, if the app is reachable, sign in as an advisor and open `/health`
   (docs/31) — **Profile linkage** and **Firm-scoped read** green prove
   token → Supabase → RLS resolves end to end on the restored data.

Only after 1–4 pass should live traffic be pointed at the restored database.

### "I suspect data loss" — triage first

Before restoring anything:

1. **Stop the bleeding.** If data is being deleted or corrupted by a live bug or
   bad actor, take the app to read-only or down first — a restore that races an
   ongoing corruption just re-corrupts. (Pausing writes: revoke the compute
   service on Render, or rotate `DATABASE_URL` so nothing can write.)
2. **Pin the incident time (UTC).** PITR needs the last-known-good timestamp;
   note when the loss started and the last confirmed-good moment. Every minute
   of uncertainty widens the RPO you accept.
3. **Do NOT restore in-place as the first move.** An overwrite is destructive and
   irreversible against the current state. Prefer restoring into a **new project**
   (flavour B, new ref) to inspect and validate the recovered data first, then
   cut over by re-pointing secrets — you keep the (possibly still partially good)
   current DB as evidence.
4. **Diagnose empty-vs-lost.** "All data gone" is far more often an auth/RLS
   misconfig (everything reads as `anon`) than actual loss — check `/health` and
   docs/31 **before** assuming a restore is needed. A restore does not fix a
   missing `role: authenticated` claim.
5. Then follow the restore procedure above and the full validation checklist.

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
