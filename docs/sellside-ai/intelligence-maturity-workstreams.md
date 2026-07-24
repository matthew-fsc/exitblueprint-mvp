# Intelligence-maturity workstreams (parallel build brief)

**Status:** Build brief / coordination contract. Unnumbered on purpose (doc numbers
are Matthew-owned; this folder is exempt — see docs/sellside-ai/README.md).

This is the authoritative brief for a set of parallel agents maturing the
**intelligence runtime** (docs/sellside-ai/05). Read it in full before touching
code. It exists so five agents can build at once without colliding: it fixes each
workstream's **file ownership**, the **shared seams** that need union-merge, the
**model-tier** each agent uses, and the **definition of done**.

## 0. The spine you are extending (read first)

Everything here extends ONE pipeline — do not build a second one.

- `server/intelligence/runtime.ts` — `runGroundedGeneration(req)`: resolve prompt →
  pick (explicit generator → strict AI; else AI-configured → `callClaude`, on ANY
  failure warn + fall through; else `compose()`) → guard (numeral firewall always;
  citation contract when `req.citation` supplied) → `{text, model}`. Draft banner +
  the no-credit fallback are built in.
- `server/intelligence/retrieval.ts` — source-agnostic cited retrieval:
  `engagementKnowledgeSource` (verified facts, data-room items, gaps, advisory
  findings) and `marketSource` (licensed market RAG). Returns `GroundedPassage[]`
  (`{body, cite_id, citation, source}`).
- `server/intelligence/guards.ts` — `numeralPostCheck` + `citationPostCheck` (pure).
- `server/agents/registry.ts` + `shared/agents/spec.ts` — the `AgentSpec` table.
- `server/diligence-qa.ts` — **the reference implementation.** A new runtime caller
  reads exactly like this: resolve its `AgentSpec` (`getAgentOrThrow`), build a cited
  payload from a retrieval source, call `runGroundedGeneration({... citation, compose,
  modelTier})`, persist an immutable, `prompt_version`-stamped row. Copy its shape.

### Non-negotiables (CLAUDE.md — do not reinterpret)

1. No LLM computes/adjusts/grades a **score** or authors a **number**. The numeral
   firewall runs on every AI draft; keep it.
2. AI output is **draft narrative**, labeled, from a server-built payload.
3. Methodology/config is **data** (rubric rows, prompt files, tier table), not code.
4. Every persisted artifact carries **`firm_id` under RLS** and a **version**
   (`prompt_version` / `rubric_version`). New tables need an RLS policy proven by
   `npm run test:rls`.

## 1. The model-tier seam (already built — USE it, don't duplicate)

`server/llm/models.ts` routes a capability **tier** to a concrete gateway model,
env-overridable (`AI_MODEL_ECONOMY/STANDARD/PREMIUM`) without a deploy:

| Tier | Default model | Use for |
|---|---|---|
| `economy` | `inclusionai/ling-3.0-flash-free` (free) | extraction, classification, the eval judge, tool routing |
| `standard` | `claude-haiku-4-5` | advisor-facing internal drafts, moderate synthesis |
| `premium` | `claude-opus-4-8` | client-/buyer-facing polished deliverables |

- A **reasoning agent** declares `modelTier` in its `AgentSpec`; pass
  `modelTier: AGENT.modelTier` into `runGroundedGeneration`.
- A **non-agent LLM call** (extraction, judge, copilot tool loop) calls
  `modelForTier('economy'|'standard')` directly for its model id.
- **Default to the cheapest tier that does the job.** Overspending on a simple task
  is a defect. If unsure between two tiers, pick the cheaper and note it.

## 2. Ownership map (how five agents avoid each other)

**Each workstream owns its files. Touch a shared file ONLY at the marked seam, and
append — never rewrite another workstream's lines.**

Shared, union-merge-at-integration files (append only):
- `server/registry.ts` — add your import at the end of the import block; add your
  function entry in your engine's section. (WS-COPILOT, WS-EXTRACT, WS-GRAPH.)
- `server/agents/registry.ts` + `tests/agents-registry.test.ts` — **only WS-GRAPH**
  adds an agent (append to the `AGENTS` array and to the sorted key list in the test).
  WS-DELIVERABLES edits existing entries' prompts/rubrics, not the array.
- `src/App.tsx` (routes) + `src/lib/queries.ts` (hooks) + nav + `src/styles.css` —
  UI workstreams append.
- `docs/06-decisions.md` (append ONE line at the very end) + `docs/README.md`
  (feature→file row).

**Do NOT edit `shared/agents/spec.ts`** — its unions already cover what you need
(`persist: 'none'` is the read-only/stateless option; reuse existing engines/guards).
If you think you must change it, stop and flag it at integration instead.

**Migrations** use the assigned filename below (parallel worktrees would otherwise
collide on a timestamp). Follow an existing `supabase/migrations/*` with `firm_id` +
RLS as the template (e.g. `20260724051418_diligence_qa.sql`).

## 3. The five workstreams

### WS-DELIVERABLES — enforce the citation contract on market-facing deliverables
The CIM / teaser / management-presentation agents **declare** `citation_contract`
but never pass `citation` to the runtime, so the guard is inert and the deliverables
don't ground on market context. Make it real.
- **Do:** in the CIM/teaser/mgmt generation paths, retrieve `marketSource` (industry
  key + size band from the assessment/company via `shared/market-keys.ts`) and pass
  `citation: { passages }` to `runGroundedGeneration`; when no market data resolves,
  pass empty passages (guard no-ops — graceful). Update the three prompt files to
  instruct: state each market figure on the same line as its `[cite_id]`. Extend the
  deterministic composers to render citations too (fallback stays valid). Add/extend
  the Bench source-axis rubric for these docs.
- **Owns:** `server/cim.ts`, `server/narrative.ts` (only `generateCim/Teaser/Management*`
  — do NOT touch the model-tier lines, owner_report, or delta_report),
  `prompts/{cim,teaser,management_presentation}.v1.md`,
  `server/llm/evals/rubrics/cim.baseline.json` (+ teaser), `tests/citation-contract.test.ts`.
- **Tier:** premium (already set). **Migration:** none.

### WS-JUDGE — the ExitBlueprint Bench LLM-judge tier + a Diligence Q&A rubric
The two-axis deterministic Bench is live and CI-gating; the LLM-judge is a typed
`NO_OP_JUDGE`. Make it real for subjective criteria — **off the free CI path.**
- **Do:** implement a versioned `LLMJudge` (replace `NO_OP_JUDGE`) that grades
  subjective criteria ("explains why a buyer cares in plain language"), anchored to a
  small golden set; run it only on a labeled `[eval]` job (guard on a secret/flag) so
  CI stays deterministic and secret-free. Add a Bench **rubric for `diligence_qa`**
  (answer = used the required retrieved facts; source = every stated fact carries its
  `[cite_id]`). Surface the judge axis on the bench scorecard.
- **Owns:** `server/llm/evals/bench.ts` (judge area), `server/llm/evals/ci.ts`,
  new `server/llm/evals/judge.ts`, `server/llm/evals/rubrics/*` (+ `diligence_qa`),
  `server/llm/evals/fixtures/*` (golden set), `prompts/bench_judge.v1.md`,
  `server/bench-metrics.ts` (persist the judge axis), `tests/bench*.test.ts`.
- **Tier:** economy (the judge is classification-shaped — use `modelForTier('economy')`).
- **Migration (only if persisting a judge column):** `20260724060002_bench_judge.sql`.

### WS-COPILOT — advisor copilot (tool-use over the registry)
There is no natural-language query agent. The compute registry is a ready tool
surface. Build a read-only copilot.
- **Do:** a new agent that exposes a **curated, READ-ONLY** subset of `REGISTRY`
  functions as Anthropic tools (e.g. engagement-graph, firm attention, valuation
  read, calibration read — never a write/gated action), runs a bounded tool-use loop
  via `resolveProvider()`, and returns a **draft-labeled** synthesis. Numbers in the
  final answer must come from tool results (reuse `numeralPostCheck` against the
  concatenated tool outputs). RLS-scoped through the caller (firm scope). New page +
  nav. v1 is **stateless** (no persist).
- **Owns:** new `server/copilot.ts` (+ `server/copilot-tools.ts`), `prompts/advisor_copilot.v1.md`,
  a `advisor-copilot` entry in `server/registry.ts` (engine `reasoning`, scope `firm`),
  `src/pages/CopilotPage.tsx`, nav + `src/lib/queries.ts`, tests.
- **Tier:** standard for synthesis; `economy` acceptable for tool-selection turns.
- **No `AgentSpec`** (it is a tool-loop, not a single-shot draft-from-payload). **No migration.**

### WS-EXTRACT — data-room extraction → candidate assessment answers
The assessment intake is manual. Read uploaded data-room documents and **propose**
structured candidate answers a human confirms. AI never writes to scoring tables.
- **Do:** a new service that reads a data-room document's parsed text (reuse
  `server/documents/parser.ts`; mirror `server/pl-extract.ts` / `server/llm/prompts.ts`
  patterns), emits candidate `(question_code, value, confidence, source_span)` rows to
  a **new staging table** (`answer_candidates`, `firm_id` + RLS), and a confirm
  endpoint that promotes a candidate through the **existing** answer path (so scoring
  stays deterministic and human-gated). A small review surface lists candidates.
- **Owns:** new `server/answer-extraction.ts`, migration
  `20260724060003_answer_candidates.sql`, `extract-answer-candidates` +
  `confirm-answer-candidate` in `server/registry.ts` (engine `knowledge`), a PromptDef
  in `server/llm/prompts.ts` (append), UI panel + `src/lib/queries.ts`, tests + an
  `test:rls` case for the new table.
- **Tier:** economy (structured extraction — the free model). **No `AgentSpec`.**

### WS-GRAPH — engagement-graph narrator ("comparable engagements" brief)
`engagementGraph` computes remediation-effectiveness deterministically with no
narrative. Wrap the runtime around it.
- **Do:** a new **reasoning agent** that builds a cited payload from `engagementGraph`
  (+ optionally firm calibration) and drafts a "gaps like these moved the DRS ~X and
  closed in ~Y" brief through `runGroundedGeneration` (numeral firewall holds; every
  figure is the deterministic graph's). v1 persists `'none'` (in-memory draft, like
  `institutional_review`) to avoid a new table.
- **Owns:** `server/engagement-graph.ts` (add build+compose+generate; keep the existing
  deterministic `engagementGraph` untouched), a new `AgentSpec`
  (`engagement_graph_brief`, engine `reasoning`, scope `firm`, persist `none`,
  guards `numeral_firewall`+`draft_label`) in `server/agents/registry.ts` **and** its
  key in `tests/agents-registry.test.ts`, `prompts/engagement_graph_brief.v1.md`,
  an `engagement-graph-brief` function in `server/registry.ts`, a UI surface +
  `src/lib/queries.ts`, tests.
- **Tier:** standard. **Migration:** none.

## 4. Definition of done (every workstream)

Run these; do not guess. A green claim without the command output is not done.
- `npm run build` — tsc + vite, clean.
- `npm test` — all pass (extend, never delete, coverage for your code).
- `npm run test:rls` — only if you added a table; prove firm isolation.
- `npm run eval` — WS-JUDGE and WS-DELIVERABLES (you touched the eval/narrative layer).
- Append ONE line to `docs/06-decisions.md` (at the very end) and a `docs/README.md`
  feature→file row.
- Follow `docs/27-engineering-patterns.md` + `docs/26-ui-system.md` (tokens/components/
  format helpers — never raw snake_case, integers, or hand-rolled tables).

Keep the diff to your owned files. At integration the shared files are union-merged;
the smaller and more append-only your shared-file edits, the cleaner that is.
