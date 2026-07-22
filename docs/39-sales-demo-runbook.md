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

---

# Dogfooding — ExitBlueprint as its own first tenant

> A sibling runbook filed in this doc (not a separate numbered doc — doc numbers
> are Matthew-owned). Where the sales demo stands up a *fictional* firm to show
> the product, **dogfooding stands up ExitBlueprint itself** as a normal tenant
> and runs our own company through our own readiness lens — "eat your own
> cooking" (docs/40 §4c/§6). It is a **customer of the platform, not a backdoor
> around it**: the internal firm is firm-isolated under normal RLS, provisioned
> through the same service-role/admin primitives every other tenant uses.

**Status:** Runbook. One command; every step is idempotent and firm-scoped.

## What you get

One firm — **ExitBlueprint** — containing:

- **ExitBlueprint** (company; signer "ExitBlueprint (self)") — our internal
  company, an exit-readiness SaaS. Two immutable, longitudinal assessments
  telling our honest story: a **baseline at DRS 43.4 (High Risk) / ORI 42** —
  founder-run, thin management bench, early-pilot customer concentration,
  informal recurring revenue, NRR not yet instrumented — improving to **DRS 73.5
  (Sale Ready) / ORI 83.8** after ~9 months of working our own roadmap, with
  four gaps still honestly open (owner dependence, customer concentration,
  management depth). Scored by the **real** engine and re-validated against the
  canonical reference scorer, so every drill-down behaves like a genuine
  assessment.
- **The remediation Plan** — the roadmap instantiated from our open gaps.
- **An evidence binder** — data-room readiness states honest to our posture
  (statements ready; owner-independence, management depth, and concentration
  marked as gaps).
- **A few Library items** — advisor-authored, **firm-scoped** notes we wrote for
  ourselves (they demonstrate tenant isolation: only the internal firm sees them).
- **An internal advisor** login (`founder@exitblueprint.com` by default).

## Prerequisites

A database with the schema + methodology already applied — i.e.
`npm run db:migrate && npm run db:seed` first (the dogfood script never migrates
or seeds methodology; it needs the active rubric, gap/playbook maps, and
data-room sections to exist).

| Var | Value |
|---|---|
| `DATABASE_URL` | Service-role connection string to the target Postgres |
| `CLERK_SECRET_KEY` | `sk_…` (hosted only) — so the internal firm/advisor provision into Clerk; omit for local dev |

## Run it

```bash
DATABASE_URL='postgresql://…' [CLERK_SECRET_KEY='sk_…'] npm run dogfood
```

The script provisions, idempotently, in order: the internal firm + company +
engagement + self-consented agreement acceptance (via `seedInternalTenant`, the
same primitives as `admin create-firm`) → the internal advisor (the same gated
path as `admin create-advisor`) → two scored assessments (baseline +
reassessment) → the engagement outcome → the remediation plan → the evidence
binder → the firm-scoped library items.

Optional env overrides: `DOGFOOD_ADVISOR_EMAIL` (default
`founder@exitblueprint.com`), `DOGFOOD_ADVISOR_NAME` (default
`ExitBlueprint Founder`), `DOGFOOD_ADVISOR_ROLE` (default `admin`).

(`npm run seed:internal` remains available to provision just the firm/company/
engagement scaffold without the assessments/plan/evidence.)

## Logging in

The internal advisor is an ordinary firm-scoped user. On **hosted** deploys they
sign in through Clerk (email-code / password-reset per your instance) — no
invitation email to accept, the membership is provisioned directly. On **local
dev** the dev emulator signs them in (password `demo`). Sign in and open the
**ExitBlueprint** engagement to see our own DRS trajectory, plan, and evidence.
There is no special role and no superadmin grant; platform-operator access, if
any, is the separate `PLATFORM_SUPERADMIN_IDS` gate this script never touches.

## The seed content (our own answers)

Our honest self-assessment inputs live in
`seed/dogfood/dogfood-snapshot-{1,2}.json`, following the same shape as
`seed/demo/*.json`. They are **canonical dogfooding facts**, deliberately
conservative — we name our own gaps. Each snapshot carries the `expected`
DRS/ORI/sub-scores/gaps computed by the canonical reference scorer
(`seed/fixtures/reference_scorer.py`); the dogfood script re-scores with the real
engine and **aborts without committing** on any drift, so the numbers can never
silently diverge from the reference implementation (rule #1). The assessments are
normal immutable snapshots tied to a `rubric_version` (rule #4).

## Isolation guarantee (CLAUDE.md rule #5)

- **Same primitives.** `seedInternalTenant` (firm + agreement + company +
  engagement) and the gated advisor path — exactly what `scripts/admin.ts`
  writes. No new provisioning path.
- **Same connection.** The service-role `DATABASE_URL`, identical to every seed
  and admin command.
- **No loosened policy.** Never disables RLS, drops/alters/adds a policy, grants
  a special role, or reads across firms. Every row carries the internal `firm_id`
  and is looked up before insert.
- **Verified, not asserted.** `npm run test:rls` (rule #5) still passes; the
  internal firm obeys the same policies as any tenant.

## Re-running / cleanup

Re-running `npm run dogfood` is safe: everything is looked up before insert and
assessments are skipped once present (they are immutable — a changed score is a
new assessment, never an edit). To reset, drop the `ExitBlueprint` firm's rows
(firm-scoped); the next run rebuilds them.
