# 05 — The intelligence runtime (consolidation) + Diligence Q&A

**Status:** Design record + build plan. Phase A/B built on this doc.

This is the doc that steps back and looks at everything we've built as *one
system*. The premise: the sell-side services worth automating (deliverables,
diligence review, market context, and next — a diligence Q&A assistant) are not
separate features. They are the **same reasoning pipeline pointed at different
inputs**. This doc (1) inventories the intelligence infrastructure we already
have, (2) shows where it is duplicated, (3) consolidates it into one runtime,
and (4) builds the Diligence Q&A assistant on that runtime — including how it
degrades when the AI call fails (no credit in the account), exactly like the
deliverables path.

## 1. The full picture — what we've already built

Read across the codebase, the "intelligence" subsystem is already substantial.
Every part of it enforces the two load-bearing rules: **rule 1** (no LLM
computes/adjusts/grades a score — deterministic engines do) and **rule 2** (AI
narrates *from* a server-built payload; every numeral must pre-exist in it).

**The generation pipelines (the reasoning engine):**
- `server/narrative.ts` — the deliverables: owner report, delta report, CIM,
  teaser, management presentation. `generateDocument` dispatches; each doc does
  `buildPayload → pickNarrative → persistGeneratedDocument`.
- `server/diligence-simulation.ts` — the proactive buyer lens: a ranked,
  severity-keyed blind-spot report built on `institutional-review`, persisted as
  an immutable run.
- `server/institutional-review.ts` — the reviewer half: assembles a read-only
  `ReviewPayload` and drafts a three-lens narrative. (Reused verbatim by
  diligence; **not** currently registered as an agent.)
- `server/cim.ts` — payload + deterministic composers for the three
  market-facing docs (no LLM plumbing of its own; narrative.ts drives them).

**The LLM plumbing:**
- `server/llm/provider.ts` — the one way to Claude: `AI_GATEWAY_API_KEY` → the
  Vercel AI Gateway (Anthropic-compatible). `aiConfigured()`, `resolveProvider()`,
  and — the important one — `aiFailureReason(err)`, which classifies the failure
  (**402 / "insufficient credit / billing"**, 401/403 auth, 429 rate-limit,
  else API error). *This is the "no money in the account" signal.*
- `server/prompt-registry.ts` — versioned prompts as `prompts/*.md` files, with a
  superadmin DB override (`analytics.prompt_templates`), no deploy needed.
- `server/llm/client.ts` — a separate, cost-logging LLM client used by
  extraction/findings (writes `llm_calls`), not by the narrative pipelines.

**Grounding (RAG) + guards:**
- `server/market-retrieval.ts` — `retrieveMarketContext` — the only RAG:
  structured + full-text (`ts_rank`) over the non-tenant `market` schema, with
  license-exposure enforcement. Market-specific today.
- `numeralPostCheck` (the numeral firewall) and `citationPostCheck` (the
  source-score guard for market claims — **exists but unwired**), both in
  `narrative.ts`.

**The agent model + quality:**
- `shared/agents/spec.ts` + `server/agents/registry.ts` — `AgentSpec`
  (engine/scope/promptKey/promptVersion/ruleBasedModel/guards/persist) and the
  six declared agents; `narrative.ts`/`diligence-simulation.ts` source their
  prompt/model constants from it.
- `server/registry.ts` — the six-engine function registry; the reasoning/knowledge
  endpoints (`generate-document`, `simulate-diligence`, `retrieve-market-context`,
  `run-bench`, …).
- `server/llm/evals/*` + `server/bench-metrics.ts` — the ExitBlueprint Bench:
  `gradeDeliverable` (answer + source score), the static + generated tiers, and
  the persisted scorecard on the platform console.

**Structured knowledge a Q&A assistant can ground + cite over (per engagement):**
verified financial facts (`server/verification.ts` → `answer_provenance`, tagged
document/ledger/self-reported), data-room items (`server/data-room.ts` →
`item_code`/`buyer_rationale`/`readiness_state`/`document_status`), the
assessment explain trace (`explainAssessment` → gaps, sub-scores, dimension
scores), and buyer-lens advisory findings (`server/advisory.ts` →
`fireAdvisoryItems`). All structured, all citable.

## 2. The duplication (the thing to fix)

The same runtime is implemented **three times** — in `narrative.ts`,
`diligence-simulation.ts`, and `institutional-review.ts`:

- **`callClaude`** — a near-byte-identical private copy in all three (same
  `resolveProvider → messages.create({model, max_tokens, thinking, …})` → join
  text blocks; only the error strings differ). **3 copies.**
- **The numeral-firewall generate loop** — `generateWithClaude` ≈
  `narrativeWithGenerator` ≈ `reviewWithGenerator`: resolve prompt → generate →
  `numeralPostCheck` → one regeneration on violation → hard-throw. **3 copies.**
- **The pick / fallback contract** — narrative extracted it to `pickNarrative`;
  diligence and institutional-review **inline** the same
  `if (generate) … else if (aiConfigured()) try/catch → compose … else compose`.
- **The failure fallback** — the `catch → aiFailureReason(err) warn → deterministic
  composer` block, repeated three times.
- **`DRAFT_BANNER` / `withDraftBanner`** — duplicated in diligence +
  institutional-review.
- **The `PROMPT_VERSION` / `MODEL` / `RULE_BASED_MODEL` triplet** — declared per
  module (narrative + diligence from the registry; institutional-review as
  literals — an inconsistency).

The one deliberate reuse (`buildInstitutionalReviewPayload`, plus
`numeralPostCheck`/`GenerateFn`/`GeneratedText` imported from `narrative.ts`) is
evidence the shared runtime is *already half-factored*. The rest is what a single
runtime absorbs.

## 3. The consolidation — one intelligence runtime

Extract the shared pipeline into `server/intelligence/`:

### `server/intelligence/runtime.ts` — `runGroundedGeneration`

```
interface GroundedRequest<P> {
  db, promptVersion, ruleBasedModel,
  payload: P,                              // the ONLY numbers the model may use
  compose: () => string | Promise<string>, // the deterministic fallback (lazy)
  draftBanner?: string,                    // prepended to AI + composed output
  citation?: { passages: {cite_id, body}[] }, // enables the citation contract
  generate?: GenerateFn,                   // test injection / forced AI path
}
runGroundedGeneration(req): Promise<GeneratedText>
```

It is the single implementation of: resolve prompt → **pick** (explicit generator
→ strict AI; else `aiConfigured()` try `callClaude` catch → `aiFailureReason`
warn → `compose()`; else `compose()`) → **guard** (numeral firewall always; the
citation contract when `citation` is supplied) → return `{text, model}`. `callClaude`,
the firewall loop, `withDraftBanner`, and the pick/fallback contract live here
**once**. The three generators become thin callers that supply `payload` +
`compose` (+ `draftBanner`/`citation`); they keep their own **persistence** (the
one true divergence — `generated_documents` vs the `diligence_simulation_runs`
transaction), because that's genuinely different per artifact.

This is a **pure-indirection refactor** — same behavior, byte-identical output,
`npm test` + the bench + the fixtures all unchanged — the same discipline as the
AgentSpec refactor. A side win: `institutional_review` gets **registered as an
agent** so all reasoning goes through the registry (removing the literal-constant
inconsistency).

### `server/intelligence/retrieval.ts` — a source-agnostic retrieval interface

Generalize `retrieveMarketContext` into a `RetrievalSource` returning
`{ passages: GroundedPassage[] }` (`{ body, cite_id, citation, source, … }`):
- `marketSource` — wraps today's market retrieval (unchanged behavior).
- `engagementKnowledgeSource` — **new**: retrieves + cites over the engagement's
  own structured knowledge (verified facts, data-room items, gaps/sub-scores,
  advisory findings), relevance-ranked to a question. No new full-text index
  needed for v1 — these are structured lookups turned into cited passages.

Now any service grounds the same way, and the citation contract polices any of
them.

## 4. The Diligence Q&A assistant (Phase B)

A buyer sends a diligence question ("What's your customer concentration?", "Walk
me through revenue by year", "What contracts are in place?"). The assistant:
1. **Retrieves** the relevant cited facts via `engagementKnowledgeSource` (+
   optional market context).
2. **Composes** a cited answer through `runGroundedGeneration` — the AI drafts
   *from* the retrieved facts; the numeral firewall + citation contract hold.
3. **Persists** the Q&A immutably (`diligence_qa`, firm/engagement-scoped,
   stamped `prompt_version`+`model`) — re-asking makes a new row.
4. Is **advisor-reviewed and draft-labeled** (rule 2). It answers *from the
   client's own data*; it never gives legal/tax advice (refer to counsel).

### The API-fail behavior (the point of consolidating first)

When the AI call fails — **no credit in the account**, or any provider error —
the deliverables path falls back to the deterministic *composer* (a rule-based
report). A free-form answer can't be composed rule-based, so the honest
degradation for Q&A is **retrieval-only**:

> `compose()` for the Q&A agent renders the **ranked, cited source evidence** the
> retrieval found — labeled `retrieval-only:diligence_qa.v1` with a banner
> *"AI synthesis unavailable — here is the source evidence to answer from."* The
> advisor still gets every relevant fact with its citation; they do the final
> synthesis.

The beauty: **the runtime needs no special case.** `compose` is already a
pluggable `() => string`. Deliverables pass "compose the rule-based report"; Q&A
passes "render the retrieved evidence." The no-credit path — the exact thing that
already works in Deliverables — comes to Q&A *for free*, which is the whole
reason to consolidate before adding the assistant.

## 5. Build order & verification

- **Phase A — the runtime.** Create `server/intelligence/{runtime,retrieval}.ts`;
  refactor `narrative.ts`, `diligence-simulation.ts`, `institutional-review.ts`
  to delegate; register `institutional_review`. Non-breaking: `npm test` /
  `npm run eval` / the fixtures all green and byte-identical.
- **Phase B — Diligence Q&A.** `diligence_qa` migration (firm/engagement-scoped,
  immutable, versioned); `engagementKnowledgeSource`; the `diligence-qa` function
  + registry entry; a Bench rubric (answer = did it use the required facts;
  source = is every fact cited); a UI surface on Buyer Lens. Verify the
  **retrieval-only fallback** by forcing an AI failure, plus a live screenshot.

Nothing here touches the rules: scores stay deterministic (rule 1), AI stays
narrative-only and draft-labeled (rule 2), the Q&A table carries `firm_id` under
RLS (rule 5), every artifact is versioned (rule 6).
