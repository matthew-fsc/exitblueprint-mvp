# State of the System — honest audit

_Snapshot date: 2026-07-13. Scope: everything on `main` after the valuation,
owner-portal, ledger-OAuth, and outcome-calibration work merged (PRs #16–#21)._

This document is deliberately blunt about what is **real and working**, what is
**simulated / stubbed**, and what is **not built yet**. It exists so nobody
mistakes the demo for a shippable product. The short version:

> **This is a genuinely strong, well-architected prototype with a real
> deterministic scoring core and a real, polished UI — running end-to-end only
> inside a local dev emulator. The database layer is production-shaped; the
> compute layer that powers every feature is not yet deployed anywhere, and
> several "integrations" are honest simulations. It demos convincingly. It does
> not yet run in production.**

Maturity by tier:

| Tier | State | One-line verdict |
|---|---|---|
| Data model + RLS (Postgres) | **Production-shaped** | Real migrations, real row-level security, firm isolation proven by tests. |
| Scoring / valuation logic | **Real** | Deterministic, versioned, locked to fixtures. The genuine IP. |
| Frontend (advisor + owner) | **Real & polished** | Full React app, themed, responsive, hand-built charts. |
| Server compute layer | **Dev-emulated only** | Runs inside Vite middleware; **no deployed functions exist**. |
| External integrations | **Simulated** | QuickBooks/Xero, owner-invite email, AI narrative (key-gated). |
| Deployment / ops | **Not built** | No hosting, no edge-function deploy, no auth email, no CI deploy. |

---

## Legend

- 🟢 **Real** — works as a real user would expect; no fakery in the path.
- 🟡 **Partial / key-gated** — real code, but needs configuration or only works under conditions.
- 🟠 **Simulated** — deliberately faked with an honest production seam marked in code.
- 🔴 **Not built** — referenced or scaffolded, but absent.

---

## 1. What is real and working 🟢

### Deterministic scoring engine — the actual IP
- `shared/scoring/engine.ts` computes the DRS, ORI, sub-scores, dimension
  scores, tiers, gaps, and flags from answers. **No LLM touches a score** (CLAUDE.md rule 1).
- Correctness is pinned to `seed/fixtures/reference_scorer.py` via committed
  fixture outputs (`tests/engine.test.ts` asserts every sub-score, dimension,
  DRS, ORI, gap, and flag matches exactly). This is a real, strong guarantee.
  - _Caveat:_ CI runs the TypeScript engine against the **committed** fixtures;
    it does not re-run the Python reference scorer to regenerate them. Parity is
    "TS matches the frozen reference output," which is what you want, but the
    Python↔fixture link is maintained by hand, not by CI.
- The rubric lives in **data** (seeded rows), not code, and is versioned
  (`rubric_versions`). Methodology changes = new version, never engine edits.

### Valuation engine
- `server/valuation.ts` is deterministic like the DRS: recast EBITDA × industry/size
  multiple × readiness factor, ranged by verification tier, minus debt/costs/taxes.
  Multiples and assumptions are versioned data (`valuation_rules_versions`).
- Locked to hand-computed values in `tests/valuation.test.ts` (EV, net-to-owner,
  wealth gap to the cent). Real, honest, and defensible.

### Multi-tenant data model + row-level security
- 15 migrations define the real schema; **every domain table carries `firm_id`
  and enforces RLS**. `scripts/rls-test.ts` proves firm isolation with 44 checks
  (advisor A can't see firm B; owners are read-only except their own ledger
  connection; OAuth tokens are unreadable by any client role).
- This is production-grade and the strongest non-scoring asset.

### Frontend (advisor workspace + owner portal)
- A complete React + Vite + TypeScript app: portfolio dashboard, engagement
  command view, intake, results/explain, roadmap (Gantt), buyer-lens, advisory
  library, valuation workbench, branded delta report, settings, and a full
  branded owner portal (home / plan / learn / documents / connect).
- Light **and** dark themes, responsive layouts, and **hand-built SVG charts**
  (Sparkline, ScoreDial, TrajectoryChart, ExitPaceChart) — no chart library.
- TanStack Query data layer; one key registry; consistent component library.

### PDF report generation
- `server/pdf.ts` renders real PDFs with `playwright-core` (the production import
  bug — a `@playwright/test` devDependency — was fixed). Owner and delta reports
  render to downloadable PDFs.

### Deterministic report composer (AI-optional)
- `server/narrative.ts` ships a **rule-based** report composer that writes the
  owner/delta reports from structured data with no API key — so reports always
  work in demos. Labeled `rule-based:owner_report.v1` so a reader can tell it
  apart from AI-drafted prose.

---

## 2. Real but conditional / key-gated 🟡

### AI narrative (Claude)
- The Claude integration is **real code** (`@anthropic-ai/sdk`, `messages.create`,
  model `claude-opus-4-8`), server-side only, key read from the environment.
- **But:** it only calls Claude when `ANTHROPIC_API_KEY` is set. With no key it
  falls back to the deterministic composer (§1). In the demo, reports are
  rule-based, not AI-written. The AI path is untested against a live key in CI
  (`tests/narrative.test.ts` injects a fake generator).
- Honest status: the seam is real and correct; the "AI writes your report"
  experience is off unless you supply a key.

### Authentication
- The app uses real `supabase.auth` (`src/lib/auth.tsx`). Against a real Supabase
  project it would be real auth.
- **In the running demo it is not.** The dev emulator (`dev/supabase-dev-server.ts`)
  accepts **any provisioned email with the fixed password `demo`** and mints its
  own JWTs with a hard-coded dev secret. That is a demo convenience, not auth.

---

## 3. Simulated / stubbed — honest fakes 🟠

Each of these has a clearly-marked production seam in the code; none silently
pretends to be real inside the codebase, but a viewer clicking the UI would not
know the difference.

### QuickBooks / Xero connection (OAuth)
- The OAuth **shape** is real: `server/ledger-oauth.ts` has begin → complete →
  disconnect, env-driven authorize URLs, token exchange, and revoke, with tokens
  quarantined in a service-only table.
- **But no live Intuit/Xero app is configured**, so every connection runs the
  **dev simulation**: it synthesizes fake tokens and a fake realm id and marks
  the connection "connected." The real token-exchange/revoke HTTP paths have
  **never been exercised against a real provider** (tests cover only the dev
  simulation). "Connected to QuickBooks" in the demo means nothing was connected.

### Ledger financial sync
- `server/ledger.ts` `pullLedgerFinancials` does **not read QuickBooks/Xero**. It
  returns the company's prior answered figures if present, else a hard-coded
  `DEFAULTS` block (`REV-ANNUAL: [3M, 3.4M, 3.8M, 4.1M]`, etc.).
- So "import verified financials from the ledger" fills in **plausible fake
  numbers**, then stamps them `connected_ledger` provenance (which lifts the
  verification %). The provenance mechanic is real; the data behind it is not.

### Owner invitation
- `server/invite.ts` creates the owner by inserting directly into `auth.users`
  and returns the dev password `demo`. **No email is sent.** The production seam
  (Supabase Auth `inviteUserByEmail` / magic link) is documented in the file but
  not implemented.

### Deal-outcome capture (the moat)
- The `deal_outcomes` table, capture UI, and firm calibration readout are **real
  and working** (advisor types the result; the prediction is snapshotted; the
  dashboard shows predicted-vs-actual). This is genuine.
- It is only "simulated" in the sense that **there is no real data yet** — the
  moat is an empty vessel until real closed deals are recorded over years. The
  demo's single calibration row is hand-entered.

---

## 4. Deployment & operations — the biggest gap 🔴

This is the most important honesty point in this document.

- **The entire server compute layer runs only inside the Vite dev emulator.**
  Every feature the frontend calls — scoring, valuation, report/PDF generation,
  ledger sync, OAuth, outcome capture, invites — is dispatched by
  `dev/supabase-dev-server.ts` as Vite middleware. There is:
  - **no `supabase/functions/` directory** (no edge functions),
  - **no functions config** in `supabase/config.toml`,
  - **no deploy scripts** in `package.json`,
  - **no deploy step** in CI (CI runs migrate → RLS test → seed → tests → build, nothing else).
- Consequence: point the frontend at a **real** Supabase project (set
  `VITE_SUPABASE_URL`) and every `/functions/v1/*` call **404s** — nothing would
  score, generate, sync, or record. The database would be real; the app would be
  inert. Porting each `/server` function to a deployed edge function (or a small
  Node service) is unbuilt work, not a config toggle.
- **n8n** scheduled workflows are described in the docs as the external
  automation layer, but **no webhook endpoint exists in the code** — it is a
  future integration, not a present one.
- No hosting, no domain, no secrets management, no transactional email, no
  monitoring, no backups/DR story.

---

## 5. UI / UX assessment

**Strong for a prototype.** This is not wireframe-ware.

- Coherent design system: forest-green brand, tokenized light/dark theming that
  actually works in both, a real component library, consistent 24px block spacing.
- Genuinely useful advisor surfaces: the portfolio table (sortable, filterable,
  sparkline trends, stale flags), the engagement command view, the roadmap Gantt,
  the buyer-lens, and the branded delta report are real product thinking, not
  placeholder screens.
- Owner portal is fully branded per firm and read-appropriate (owners can't edit
  scores; they can manage their own ledger connection).
- Charts are bespoke, accessible SVG (aria labels, viewBox scaling), theme-aware.

**Honest UX caveats:**
- Numeric inputs (EV, EBITDA) are raw number fields with no thousands formatting
  or validation beyond type coercion.
- Several flows depend on the fake auth/ledger, so "it works" in the demo doesn't
  equal "it works for a real user."
- No empty-state polish audit was done across every page; the new surfaces have
  good empty states, older ones vary.
- Accessibility is decent (labels, roles on charts) but has not been formally audited.

---

## 6. Data & test integrity

- **83 automated tests across 15 files**, all green, plus **44 RLS isolation
  checks**. Coverage is real and meaningful: engine fixtures, valuation math,
  verification thresholds, ledger sync, OAuth lifecycle, outcome calibration,
  invites, PDF smoke, compare/supersede.
- Tests that need a database **skip** when `DATABASE_URL` is unset (they don't
  fail silently — they're marked skipped). CI provides a real Postgres, so they
  run there.
- Seeds are idempotent (CI seeds twice to prove it) and the demo tenant validates
  against the reference scorer.
- Gaps: no end-to-end/browser test suite in CI (Playwright is used ad hoc for
  screenshots, not as a gated E2E); the AI path and the real OAuth path have no
  live-integration tests.

---

## 7. Security & tenancy posture

- **Good bones.** RLS is enforced on every domain table and proven by tests.
  OAuth tokens live in a service-only table with no grant to `authenticated` —
  a client JWT cannot read a token even in principle.
- **Demo-only weaknesses (expected, but must not ship):** the dev emulator's
  hard-coded JWT secret and universal `demo` password; direct `auth.users`
  inserts for invites; no rate limiting, CSRF hardening beyond the OAuth state
  param, or secret rotation. These are dev-stack artifacts, not production auth.

---

## 8. What it would take to be a real product (punch list)

Roughly in dependency order:

1. **Deploy the compute layer.** Port every `/server` module to Supabase Edge
   Functions (or a small Node service) and wire real routes for `/functions/v1/*`.
   Today this only exists as Vite middleware. _(Largest single item.)_
2. **Stand up a real Supabase project** and run the migrations there; move off the
   emulator; set `VITE_SUPABASE_URL` / anon key.
3. **Real auth**: replace the `demo`-password emulator with Supabase Auth, and
   replace the invite's `auth.users` insert with `inviteUserByEmail` + email.
4. **Real QuickBooks/Xero**: register live apps, set the OAuth env vars, and
   actually test token exchange, refresh, and revoke against the providers.
5. **Real ledger ingestion**: implement `pullLedgerFinancials` against the
   accounting APIs so verified financials are real, not `DEFAULTS`.
6. **AI on by default**: provision `ANTHROPIC_API_KEY` in the server environment
   and add a live-path smoke test.
7. **Ops**: hosting, secrets, transactional email, monitoring, backups; add a
   deploy stage to CI; add a browser E2E suite.
8. **n8n**: build the actual webhook endpoints the scheduled workflows call.

---

## Bottom line

The **hard, differentiated parts are real**: a deterministic, versioned,
test-locked scoring and valuation engine, a genuinely multi-tenant Postgres
schema with enforced isolation, and a polished, coherent UI across advisor and
owner surfaces. That is the part most teams get wrong, and it's right here.

The **easy-to-fake parts are faked**, honestly and with marked seams:
integrations (QuickBooks/Xero, email, live AI) are simulated, and — most
importantly — **the whole compute layer is dev-emulated with no deployment path
yet**. This is a high-quality prototype that demos as a finished product but is
one substantial infrastructure push (items 1–3 above) away from actually running
for a real customer.
