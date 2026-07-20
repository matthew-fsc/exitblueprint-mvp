# Architecture map — the whole system at a glance

A visual companion to `docs/01-architecture.md` (prose) and the non-negotiable
rules in CLAUDE.md. Diagrams render on GitHub. Start here to understand how the
pieces fit; then use `docs/27-engineering-patterns.md` to add to them.

---

## 1. System layers

The frontend never talks to Postgres directly for writes — it goes through the
**compute layer**, which is the *same router code* whether it runs as the dev
emulator or the production Node service. Identity comes from Supabase Auth today
(Clerk is planned, `docs/24`); every table is isolated by **Row-Level Security**.

```mermaid
flowchart TB
  subgraph Client["Browser — React + Vite"]
    UI["Pages + design system<br/>(src/pages, src/components/ui)"]
    Q["Reads: react-query hooks<br/>(src/lib/queries.ts) — direct via RLS"]
    INV["Writes/compute: invokeFunction()<br/>(src/lib/supabase.ts)"]
  end

  subgraph Auth["Identity"]
    SB_AUTH["Supabase Auth (today)<br/>→ Clerk via JWKS (planned, docs/24)"]
  end

  subgraph Compute["Compute layer — one router, two hosts"]
    ROUTER["server/functions.ts<br/>authorize → gate → dispatch"]
    HOST["Host: dev emulator (dev/) <br/>or prod Node service (server/http.ts)"]
  end

  subgraph Data["Supabase Postgres"]
    RLS["Row-Level Security<br/>(app.user_* helpers · firm_id on every table)"]
    TABLES["firms · companies · engagements ·<br/>assessments · gaps · tasks · documents · …"]
  end

  subgraph External["External services (server-side only)"]
    ANTH["Anthropic — narrative only"]
    STRIPE["Stripe — billing (planned)"]
    LEDGER["QuickBooks/Xero — ledger OAuth"]
  end

  UI --> Q --> SB_AUTH
  UI --> INV --> SB_AUTH
  Q -->|"RLS-scoped SELECT"| TABLES
  INV -->|"/functions/v1/*"| HOST --> ROUTER
  ROUTER -->|"asUser() — set role + JWT claims"| RLS --> TABLES
  ROUTER --> ANTH
  ROUTER --> STRIPE
  ROUTER --> LEDGER
```

---

## 2. A compute request, end to end

Every `/functions/v1/<name>` call is **authorized before it runs**: the caller's
firm is resolved from their profile (never trusted from the request body), the
billing gate can refuse paid actions, then the handler executes under RLS.

```mermaid
sequenceDiagram
  participant B as Browser
  participant H as Host (emulator / Node)
  participant R as functions.ts
  participant DB as Postgres (RLS)

  B->>H: POST /functions/v1/{name} (Bearer JWT, body)
  H->>H: verify JWT (HS256 or JWKS) → Claims{sub, role}
  H->>R: handleFunctionCall(name, body, ctx)
  R->>R: REGISTRY[name] — look up engine, scope, gate, handler
  R->>DB: authorize(scope) — resolve firm_id from profile (asUser)
  Note over R: firm_id comes from the profile,<br/>never from the body
  R->>R: entitlementGate() — refuse if BILLING_ENFORCED & not entitled
  R->>DB: spec.handler({ service, firmId, body, userId })
  DB-->>R: rows (RLS-scoped to the firm)
  R-->>B: JSON result (or 402/403/404)
```

`server/functions.ts` is the **gateway**; `server/registry.ts` is the declarative
table of every endpoint (`{ engine, scope, gated?, handler }`). Adding a function
is one registry entry — the gateway is never edited — and it is impossible to add
one without assigning it an engine and an explicit, auditable auth scope. See §6.

---

## 3. The load-bearing rule: deterministic scoring, AI is narrative-only

The DRS/ORI scores are produced by **versioned, rule-based code** that must
reproduce the Python reference fixtures exactly. The Claude API only writes prose
*from* those numbers — it never computes or edits a score.

```mermaid
flowchart LR
  A["Assessment answers<br/>(inputs, immutable snapshot)"] --> E["shared/scoring/engine.ts<br/>(deterministic, versioned)"]
  E --> S["sub_scores → dimensions →<br/>DRS (business) · ORI (owner)"]
  S --> G["gaps + playbooks<br/>(rule-thresholds)"]
  S -. "read-only, structured" .-> N["server/narrative.ts<br/>+ Anthropic"]
  G -. "read-only" .-> N
  N --> DOC["Draft narrative<br/>(labeled draft, prompt_version'd)"]

  REF["seed/fixtures/reference_scorer.py"] -.->|"CI must match exactly"| E
  classDef ai fill:#fde,stroke:#c39
  class N,DOC ai
```

*Dashed line into narrative = one-way: data flows to the LLM, never back to a
scoring table (rule 2).*

---

## 4. Data & tenancy model (the spine)

`firm_id` is on **every** domain table; RLS scopes all reads/writes to the
caller's firm. Assessments are **immutable snapshots** tied to a `rubric_version`
— re-assessing creates a new one, never edits the old (rule 4).

```mermaid
erDiagram
  FIRMS ||--o{ COMPANIES : owns
  FIRMS ||--o{ PROFILES : "advisors / reviewers / owners"
  COMPANIES ||--o{ ENGAGEMENTS : "assessed repeatedly"
  ENGAGEMENTS ||--o{ ASSESSMENTS : "immutable snapshots"
  ENGAGEMENTS ||--o{ TASKS : "roadmap"
  ENGAGEMENTS ||--o{ DOCUMENTS : "data room / evidence"
  ASSESSMENTS ||--o{ DIMENSION_SCORES : "deterministic"
  ASSESSMENTS ||--o{ GAPS : "flagged"
  FIRMS ||--o| FIRM_SUBSCRIPTIONS : "billing (Stripe)"
  RUBRIC_VERSIONS ||--o{ ASSESSMENTS : "versions"
```

---

## 5. Repo module map — where things live

```mermaid
flowchart TB
  subgraph FE["Frontend  (src/)"]
    P["pages/ — advisor workspace + owner portal"]
    C["components/ui/ — design system (docs/26)"]
    L["lib/ — supabase client, queries, auth, format,<br/>pure logic (alignment, workstreams, entitlements)"]
    A["App.tsx — routes + RequireAdvisor/Staff/Owner guards"]
  end
  subgraph BE["Backend  (server/)"]
    F["functions.ts — the gateway (authorize by scope)"]
    REG["registry.ts — six-engine function table<br/>{ engine, scope, gated, handler }"]
    HTTP["http.ts — prod Node host  ·  auth-jwt.ts"]
    D["domain: scoring, valuation, roadmap, narrative,<br/>pdf, documents/, ledger*, verification, entitlements"]
  end
  subgraph SH["shared/  (FE + BE)"]
    SC["scoring/engine.ts — the DRS/ORI engine"]
    SM["entitlements, comparables, rubric-seed"]
  end
  subgraph DBP["Database & data"]
    MIG["supabase/migrations/ — schema + RLS"]
    SEED["seed/ — canonical rubric, playbooks,<br/>fixtures/reference_scorer.py, demo tenant"]
  end
  subgraph OPS["Dev & ops"]
    DEV["dev/ — Supabase emulator"]
    SCR["scripts/ — migrate, seed, rls-test, admin"]
    CI[".github/workflows/ci.yml"]
  end

  P --> C --> L --> F
  F --> REG --> D --> SC
  D --> MIG
  SC --> SEED
```

---

## 6. The six engines — one codebase, read six ways

The platform is a small number of **durable engines** (capabilities many features
draw on), not a pile of independent screens (`ExitBlueprintPlatformArchitecture`
§01). The engines are **not services** — they are a way of reading one codebase —
and `server/registry.ts` makes them structural: every compute endpoint is tagged
with the engine it belongs to, so the map below is *derived from code*, not prose
that can drift.

```mermaid
flowchart LR
  ENG["engagement<br/>(the primary object)"]
  subgraph Engines["The six engines"]
    ID["Identity — who & what<br/>authn · authz · tenancy · audit<br/><i>the gateway itself: functions.ts + RLS</i>"]
    KN["Knowledge — what we know<br/>assessments · evidence · financials · outcomes"]
    WF["Workflow — what happens next<br/>engagement lifecycle & progression"]
    RU["Rules — the facts<br/>scoring · valuation · roadmap · calibration"]
    RE["Reasoning — the explanation<br/>AI narratives & assembled docs (draft-only)"]
    CO["Collaboration — who participates<br/>invites · review queue · verification"]
  end
  ID --- ENG
  KN --- ENG
  WF --- ENG
  RU --- ENG
  RE --- ENG
  CO --- ENG
```

Each `REGISTRY` entry declares `engine` (one of the six) and `scope` (its auth
gate). `identity` owns **zero** endpoints on purpose: it is the authorize + RLS
layer (`functions.ts` + Postgres) that every call passes through, not a feature
set. `tests/registry.test.ts` holds these invariants — valid engine + scope on
every function, the billing gate reads the registry, and identity stays the
gateway. Rules never let AI compute a score; Reasoning only ever explains
(CLAUDE.md rules 1–2), and the registry's engine tags make that boundary legible.

---

## Where to go next
- **Add a feature** → `docs/27-engineering-patterns.md` + `templates/`.
- **UI** → `docs/26-ui-system.md`.
- **Data model detail** → `docs/02-data-model.md`. **Scoring** → `docs/03` / `docs/07`.
- **Path to production** (Clerk, Stripe, ops) → `docs/24` / `docs/25` / `docs/10`.
