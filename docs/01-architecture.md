# 01 - Architecture

> **Current-state note (2026-07).** This doc captures the original layer intent;
> the visual, up-to-date companion is `docs/28-architecture-map.md`. Two things
> have changed since it was written: **identity is Clerk** (RLS validates Clerk
> JWTs via JWKS — the hosted Supabase-Auth login was removed, `docs/30`), and the
> server functions run behind a single **compute router** (`server/functions.ts`
> → `server/http.ts` on Render) rather than per-function edge functions. **Stripe**
> billing is also live (`docs/24`).

## Layers

```
React (advisor workspace + owner portal)
        |
Clerk (identity: login, MFA, Organizations = firms) --- JWKS --> RLS
        |
Supabase (Postgres + RLS + Storage) <--- single source of truth for data
        |
Compute router (server/functions.ts, hosted by server/http.ts):
  - scoring engine (deterministic, versioned)
  - narrative service (Claude API, server-side only)
  - billing (Stripe), ledger OAuth, document verification
  - webhook endpoints for n8n
        |
n8n (external): re-assessment reminders, stall alerts, content drip
```

## Component responsibilities

### Scoring engine
- Input: assessment_id
- Reads: answers + rubric (dimensions, questions, weights, thresholds) for that assessment's rubric_version
- Writes: dimension_scores, overall score on the assessment, gap rows for any dimension/threshold breach
- Pure function of stored data. Same input always produces same output. Unit-tested against hand-scored fixtures before anything is built on top of it.

### Narrative service
- Input: assessment_id + document type (owner report | delta report | CIM)
- Reads: scores, gaps, playbook summaries, company context
- Calls Claude with the prompt contract in docs/04-ai-layer-spec.md
- Writes: generated_documents row (content, prompt_version, model, created_at)
- Never writes to assessments, scores, or gaps.

### Roadmap generator
- Deterministic: for each open gap, instantiate the mapped playbook's task templates into tasks with default sequencing. Advisor edits from there.

### n8n integration
- n8n calls authenticated webhooks: GET stale-engagements, GET stalled-tasks, POST trigger-reassessment-reminder, GET next-content-module(engagement_id)
- All scheduling logic lives in n8n; all data logic lives in the app. n8n never touches the database directly.

## Environments and safety

- Local dev against Supabase local; migrations via supabase CLI, committed to repo.
- Anthropic API key lives server-side only (edge function secret). The browser never sees it.
- RLS: advisors scoped to their firm_id; owners scoped to their company_id; admin role bypass via service key on server only. RLS reads identity from validated Clerk JWT claims (`docs/30`).

## Explicit non-goals for v1

Real-time analytics, external financial data ingestion (PitchBook etc.), benchmarking across firms, white-label theming. Design decisions should not add complexity to serve these yet.
