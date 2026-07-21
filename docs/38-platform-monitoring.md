# 38 — Platform monitoring (ExitBlueprint team side)

**Status: Reference / Runbook.** How the ExitBlueprint operating team watches the
platform end to end. Four monitoring domains — **infra & uptime**, **product &
usage**, **business & billing**, **security & compliance** — built on **one shared
set of analytics rails**, not four disconnected stacks.

Companion: `docs/32-observability.md` (error-monitoring seam), `docs/08-operations.md`
(environments, backups), `docs/28-architecture-map.md` (the system), `docs/24`
(production readiness). Non-negotiables it must respect: **CLAUDE.md**.

---

## 0. The one guardrail that shapes everything

The prompt for this work noted that "data gets shared pretty openly across the
hosting services so we can create good analytics." Team-side monitoring is
completely legitimate — but it does **not** relax the platform's non-negotiables,
and the design here is built so it can't:

- **Firm isolation is absolute (CLAUDE.md §5).** RLS scopes every tenant read to
  one firm. Cross-firm aggregation for *our* analytics is allowed **only** through
  the service-role path, and it is walled into a dedicated `analytics` Postgres
  schema that **no `authenticated`/`anon` role can read** (see §3). "Good
  analytics" for us never means loosening a tenant policy.
- **No PII leaves the trust boundary.** The log/telemetry seam already scrubs
  tokens, secrets, bodies, emails, phones and anything but ids (`scrubContext`,
  `docs/32`). Every third-party sink (Sentry, Vercel, host log drains) receives
  scrubbed data only. Aggregates ship counts and ids, never client financials.
- **Scoring is untouched (CLAUDE.md §1–2).** Monitoring is **read-only**. Nothing
  here writes a score, mutates an immutable assessment, or lets AI influence one.
- **Benchmarking stays out of scope.** Cross-firm *client-facing* analytics (the
  anonymized benchmarking layer) is explicitly deferred (CLAUDE.md §5). This doc
  is **internal operator visibility only** — a different audience and a different
  gate (`PLATFORM_SUPERADMIN_IDS`, never a firm role).

If a future change would pipe a raw client record into a third-party analytics
tool, that is a scope change requiring Matthew's sign-off — not a monitoring task.

---

## 1. The hosting surfaces we monitor

The platform is spread across managed services, each of which exposes its own
telemetry openly (dashboards, log drains, webhooks, APIs). The rails **aggregate**
those, they don't replace them.

| Surface | What it runs | Native telemetry we consume |
| --- | --- | --- |
| **Vercel** | React frontend | Web Analytics + Speed Insights (already mounted, `src/App.tsx`), build/deploy status, function logs |
| **Render** | Node compute service (`server/http.ts`) | `/health` + `/ready`, structured one-JSON-line-per-request access logs → log drain, deploy events, instance metrics |
| **Supabase** | Postgres + RLS + Storage | DB metrics (connections, CPU, disk), Postgres logs, backup/PITR status (`docs/08`) |
| **Clerk** | Identity (Orgs=firms) | Dashboard analytics (sign-ins, MFA, invites), provisioning webhook (`/webhooks/clerk`) |
| **Stripe** | Billing | Dashboard (MRR, churn, failed payments), signature-verified webhook (`/webhooks/stripe`) → `billing_events` |
| **Anthropic** | Narrative generation | Per-call token/cost/latency captured in-DB (`llm_calls`), plus the Anthropic console |
| **n8n** | Scheduled continuous-eval | Calls `/webhooks/scheduled/*`; n8n's own run history |
| **Sentry** (seam, off until DSN) | FE + server errors | Exceptions, release health (`docs/32`) |

---

## 2. The rails — one event/metrics spine, four readouts

The insight is that all four domains already emit into **the same append-only
tables** the app writes during normal operation. We don't add a parallel
analytics pipeline; we roll up what's already there.

```
   app + hosting services (write during normal operation)
        │
        ├─ usage_events         → product & usage
        ├─ data_access_log      → security & compliance
        ├─ billing_events /      → business & billing
        │  firm_subscriptions
        ├─ llm_calls            → AI cost/latency (business + ops)
        ├─ engagements /         → activation, funnel (product + business)
        │  assessments / firms
        └─ Render logs / Sentry / → infra & uptime
           Vercel / host dashboards
        │
        ▼
   analytics schema  (service-role-only cross-tenant rollup VIEWS)   ← the rails
        │
        ▼
   GET /internal/metrics  (superadmin-gated JSON, one place all four read)
        │
        ▼
   team dashboard  (Metabase / Grafana / a small internal page — §6)
```

Two properties make this "one rail, four readouts":

1. **One store, one gate.** Every domain aggregate is a view in the `analytics`
   schema, and the *only* app-level way to read them is the superadmin-gated
   `GET /internal/metrics`. Add a domain → add a view + a block in that endpoint;
   the gate, isolation, and transport are shared.
2. **Derived from code, not re-instrumented.** The rollups read the tables the app
   already populates. New product events are just new `usage_events` rows — they
   flow to the dashboard with no new plumbing.

---

## 3. Domain-by-domain plan

### A. Infra & uptime
**Goal:** know within minutes if the platform is down, slow, or erroring.

- **Liveness/readiness:** `/health` (process up) and `/ready` (DB reachable) already
  exist. Point an external uptime monitor (Better Stack / Pingdom / UptimeRobot) at
  `https://api.exitblueprint.net/ready` and the Vercel app root; alert on 2 failures.
- **Errors:** enable the Sentry seam (set `SENTRY_DSN` on Render, `VITE_SENTRY_DSN`
  on Vercel — `docs/32`). Until then, errors are structured console lines in
  Render's log drain (`msg:"captured_error"`).
- **Latency / status codes:** Render access logs already emit `{method,path,status,ms}`
  per request. Ship the log drain to a log store (Better Stack / Datadog / Grafana
  Loki) and chart p50/p95 latency and 5xx rate per route.
- **Webhook health (in-DB):** `analytics.ops_webhook_health` surfaces Stripe event
  volume, **unprocessed** count, and last-received time — a stuck webhook is an
  outage even when `/ready` is green.
- **Frontend health:** Vercel Speed Insights (already mounted) for Core Web Vitals.

**Alerts:** `/ready` down; 5xx rate > threshold; Sentry new-issue spike; any
`billing_events` unprocessed for > N minutes.

### B. Product & usage
**Goal:** understand advisor/owner behavior and where the journey leaks.

- **Source:** the `usage_events` table (onboarding, assessment sections, document
  request-vs-upload, review turnaround, report delivery). Append-only, firm-scoped
  for tenants; aggregated cross-firm for us via `analytics.usage_daily`.
- **Funnel:** `analytics.assessment_funnel` — engagements → assessments started →
  completed → scored. This is the core activation metric.
- **Adoption:** per-firm activity + last-activity timestamp in
  `analytics.firm_overview` (which firms are live vs. dormant).
- **Instrumentation gap to close:** audit that the frontend actually emits the
  `usage_events` the table was designed for (section viewed/abandoned, doc
  requested, report downloaded). Where a step isn't emitting, add the event — no
  schema change, it's just another row.

### C. Business & billing
**Goal:** the commercial health of the platform.

- **Firms/engagements/assessments:** `analytics.platform_totals` (grand totals) and
  `analytics.firm_overview` (per-firm rollup with plan + subscription status).
- **Subscriptions:** `analytics.subscription_summary` — firm counts by plan and
  status (trialing/active/past_due/canceled), seat totals. **MRR/dollar amounts
  live in Stripe, not our DB** (only `stripe_price_id` is stored) — pull revenue
  from the Stripe dashboard/API; our rails give the *unit* counts.
- **AI cost:** `analytics.ai_cost_daily` — Anthropic tokens, `cost_usd`, and average
  latency by day and model, straight from `llm_calls`. This is COGS visibility.

**Alerts:** `past_due` count rising; a firm's active-engagement count dropping to
zero (churn signal); daily AI cost anomaly.

### D. Security & compliance
**Goal:** prove isolation holds and spot misuse.

- **Access log:** `analytics.access_log_daily` rolls up `data_access_log`
  (document/report reads and downloads) by action and resource type — the audit
  trail, aggregated for anomaly-spotting (a spike in downloads from one actor).
- **Isolation drift:** run `npm run test:rls` in CI and post-restore (`docs/08`).
  This slice adds an assertion that the `analytics` schema itself is unreadable by
  an `authenticated` role — the rails can't become a cross-firm leak.
- **Auth anomalies:** Clerk dashboard (failed sign-ins, new devices, MFA); route
  Clerk's security events into the alert channel.
- **Secret scanning:** GitHub secret-scanning on the repo (already available via
  the platform's GitHub app).

---

## 4. What ships in the first wiring slice (this PR)

The rails, end to end, at the cheapest useful width:

1. **`analytics` schema** (`supabase/migrations/..._platform_analytics.sql`) — a set
   of read-only cross-tenant rollup **views** covering all four domains
   (`platform_totals`, `assessment_funnel`, `usage_daily`, `firm_overview`,
   `subscription_summary`, `ai_cost_daily`, `access_log_daily`,
   `ops_webhook_health`). Granted to **`service_role` only**; `authenticated`/`anon`
   are deliberately never granted — the isolation guarantee.
2. **`GET /internal/metrics`** (`server/http.ts` + `server/platform-metrics.ts`) —
   a superadmin-gated JSON endpoint (reuses `PLATFORM_SUPERADMIN_IDS` via
   `isPlatformSuperadmin`, the same cross-tenant gate as `seed-methodology`) that
   assembles the four-domain snapshot from the views. It sits beside `/health`,
   `/ready`, and the webhooks — a platform operations route, not a tenant function,
   so cross-tenant aggregate SQL never enters the per-firm function registry.
3. **Tests:** `tests/platform-metrics.test.ts` (assembles the shape from a fake DB,
   no live DB needed) and an `rls-test.ts` assertion that a tenant role cannot read
   the `analytics` schema.

Not in this slice (see §5): the external uptime monitor, log-drain shipping, the
dashboard UI, and turning on Sentry DSNs — those are operator/console actions.

---

## 5. Rollout order (after this PR)

1. **Turn on error monitoring** — set `SENTRY_DSN` (Render) + `VITE_SENTRY_DSN`
   (Vercel), redeploy (`docs/32`). Zero-code; highest signal-per-effort.
2. **External uptime monitor** on `/ready` + app root, with an alert channel
   (Slack/email/PagerDuty).
3. **Ship Render's log drain** to a log store; chart latency + 5xx per route.
4. **Stand up the team dashboard** (§6) reading `GET /internal/metrics` + the
   Stripe/Clerk/Supabase dashboards.
5. **Close the `usage_events` instrumentation gaps** found in the §3B audit.
6. **Wire alerts** on the thresholds named per domain in §3.

---

## 6. The team dashboard

`GET /internal/metrics` returns a single JSON document with `totals`, `product`,
`business`, `security`, and `ops` blocks (plus the `corpus`/`moats` moat rails).
Options to surface it, cheapest first:

- **Metabase/Grafana over the `analytics` schema** (recommended for ad-hoc
  slicing) — point a BI tool at the service-role connection, restricted to the
  `analytics` schema; every view is chart-ready. No app code.
- **The in-app Platform Console — BUILT.** A single self-contained superadmin
  surface at **`/internal`** (`src/pages/PlatformConsolePage.tsx`, data +
  pure helpers in `src/lib/platformConsole.ts`) that renders the whole endpoint
  through the design system: at-a-glance totals, the **business-development**
  readout (activation funnel, subscription units, and the firm account/churn
  book — dormant firms first), product usage, the moat/business-plan KPIs, ops &
  AI cost, and the security access log. Deliberately **independent of the tenant
  product**: its own route and chrome (no advisor `Shell`/firm branding), read-
  only, and it imports no tenant query hooks — it only reads the rail. Not linked
  from any tenant nav; navigate to it directly. The server's
  `PLATFORM_SUPERADMIN_IDS` gate is the real authority (a signed-in non-superadmin
  just sees an access card); the page's `RequireAuth` wrapper only checks "signed
  in."
- **A scheduled digest** — an n8n job hits `/internal/metrics` daily and posts the
  headline numbers to Slack.

---

## 7. Environment / config

No new secret. The endpoint reuses `PLATFORM_SUPERADMIN_IDS` (comma-separated Clerk
user ids, set on the Render compute service — `docs/14`, `render.yaml`). Unset →
`/internal/metrics` replies 403, same default-deny as `seed-methodology`. Sentry
DSNs and the uptime/log/dashboard tools are configured in their own consoles.
