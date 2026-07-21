# Sales demo runbook — a live tenant you can sign in to

How to stand up a persistent **sales-demo tenant** in a hosted environment and
get **two logins you control** — an advisor login (the full workspace) and an
owner login (the client portal) — pointed at the same demo engagement. Use it to
demo the product live in a sales call from any laptop.

**Status:** Runbook. One command; every step is idempotent and firm-scoped.

For the *local* dev demo (throwaway Postgres + dev-emulator login for
`npm run dev`), use `npm run dev:demo` instead — see `scripts/dev-demo.sh`.
Identity/provisioning background is in [30-clerk-cutover-runbook](./30-clerk-cutover-runbook.md).

---

## What you get

One firm — **Blueprint Demo Advisors** — containing:

- **Cascade Facility Services** — the deep-dive client: two longitudinal
  assessments (Needs Work → Sale Ready over ~9 months), the remediation roadmap,
  an EBITDA recast + $8M wealth target (Three Legs of the Stool), a run
  verification tab, a populated data room, and an engagement log. Scored by the
  **real** engine and validated against the reference scorer, so every drill-down
  behaves like a genuine assessment.
- **A ~15-company book of business** (`seed:portfolio`) so the advisor dashboard
  shows a realistic portfolio with score deltas and staleness.
- **Firm branding** ("Cascade Wealth Partners") on client-facing reports.

Plus two logins you name at run time:

| Login | App role | Lands on | Shows |
|---|---|---|---|
| Advisor | `admin` (default) | `/` | The advisor workspace — portfolio, deep-dive, roadmap, valuation, verification |
| Owner | `owner` | `/portal` | The read-only client portal for the Cascade engagement |

Everything lives under the demo firm; RLS keeps it isolated from every real
firm, and re-running never touches another tenant.

## Prerequisites

A deployed environment with the schema + methodology already applied (your
normal deploy does this — the script never migrates or seeds methodology), and:

| Var | Value |
|---|---|
| `DATABASE_URL` | Service-role connection string to the deployed Postgres |
| `CLERK_SECRET_KEY` | `sk_…` — so the firm/advisor/owner provision into Clerk |

Pick two email addresses you control for the logins. They must differ; the
simplest is one inbox with a plus-alias, e.g. `you@firm.com` and
`you+owner@firm.com` (both deliver to the same inbox, but are distinct identities
to Clerk).

## Run it

```bash
DATABASE_URL='postgresql://…' CLERK_SECRET_KEY='sk_…' \
  npm run demo:sales -- you@firm.com you+owner@firm.com
```

The script provisions, in order: the demo firm (+ Clerk organization) →
the advisor login → the deep Cascade client → the book of business →
the owner login → scopes the owner to the Cascade client. It prints both
logins and where each lands when done.

Optional env overrides: `DEMO_ADVISOR_ROLE` (default `admin`),
`DEMO_PORTFOLIO_COUNT` (default `15`).

## First sign-in

Both users sign in through Clerk using the email-code / password-reset flow
(per your instance's enabled strategies) — there is **no invitation email to
accept**, because the script provisions the Clerk membership + profile directly
(the same path as `admin create-advisor`). Sign in as the advisor at your app
URL to land on the workspace; sign in as the owner to land on `/portal`.

## A suggested demo path

1. **Advisor, portfolio** (`/`) — the book of business, score deltas, staleness.
2. **Advisor, deep-dive** — open Cascade Facility Services: the DRS and its six
   dimensions, then the delta between the two snapshots (Needs Work → Sale Ready).
3. **Advisor, roadmap + valuation** — the remediation plan tied to gaps, and the
   EBITDA recast + wealth target (the Three Legs of the Stool).
4. **Advisor, verification + data room** — the sell-side readiness surfaces.
5. **Owner portal** (`/portal`, as the owner login) — the same engagement as the
   business owner sees it: their score, plan, and learning modules.

To show the real advisor→owner invite flow live, invite a fresh owner from the
app UI instead of using the pre-provisioned owner login.

## Re-running / cleanup

Re-running `npm run demo:sales` is safe: seeds top up rather than duplicate, and
provisioning upserts. To reset the demo firm's data, drop the
`Blueprint Demo Advisors` firm's rows in the DB (firm-scoped); the seeds rebuild
them on the next run.
