# Sell-side AI — applying the Harvey pattern to Exit Blueprint

This folder is a set of **architecture writeups**: how to apply the concepts
that make Harvey (legal AI) work to sell-side M&A advisory, mapped onto
*this* repo's seams. They are design records (Strategy/Reference), not build
specs — no code ships from reading them. Each proposes an architecture, names
the files it would touch, and shows how it stays inside the CLAUDE.md
non-negotiables.

> **Doc-numbering note.** Doc numbers in `docs/` are Matthew-owned and never
> auto-assigned (see `docs/README.md`). These live in their own folder on
> purpose so nothing races the numbering. If any is promoted into the main
> numbered sequence, Matthew assigns the number.

## Why Harvey is the right reference

Harvey turns scarce professional judgment (a BigLaw associate's) into
software by combining four things: **domain-expert-authored workflows**,
**RAG grounded in authoritative sources with mandatory citation**, a hard
**deterministic / generative split**, and **evaluation as a first-class,
rubric-graded discipline**. Sell-side M&A is the same shape of work —
high-stakes, document-heavy, liability-bearing, produced by a scarce expert
who bills for judgment.

The striking thing is how much of that discipline this codebase *already*
enforces, independently:

| Harvey concept | Already in this repo |
|---|---|
| Deterministic layer the model never touches | Rule #1 scoring engine; `server/valuation.ts` (no LLM computes a value) |
| AI writes work product *from* structured data, labeled draft | Rule #2; `server/narrative.ts`; the `DRAFT_BANNER` on diligence runs |
| Grounding / anti-hallucination guardrail | The **numeral firewall** (`numeralPostCheck`) + deterministic-composer fallback |
| Methodology lives in versioned data, not code | Rule #3; `rubric_version`, `valuation_rules_version`, `prompt_version` |
| Domain-expert-authored, no-deploy prompt edits | `server/prompt-registry.ts` (`analytics.prompt_templates` overrides) |
| Agentic reviewer of a work product | `server/diligence-simulation.ts` (buyer-lens blind-spot report) |
| Evaluation harness that fails CI on regression | `npm run eval` → `server/llm/evals/` |

So these writeups are not "adopt a new architecture." They are **three
extensions** of what exists, in priority order.

## The three writeups

1. **[01 — Market-intelligence RAG (paid third-party data)](./01-market-intelligence-rag.md)**
   The grounded retrieval layer over *licensed* M&A data — comps, precedent
   transactions, industry multiples. Matthew's stated priority. The hard part
   is doing it **without** breaching the deterministic/narrative wall (rule
   #1/#2) or the tenancy model (rule #5): structured licensed data feeds the
   *deterministic* valuation engine as a versioned multiple source, while
   retrieval-grounded market context feeds *narrative* with a citation
   contract. This is the biggest value unlock and the one with the most rules
   to respect.

2. **[02 — ExitBlueprint Bench (evaluation rubric)](./02-evaluation-bench.md)**
   Harvey's crown jewel is BigLaw Bench: grade AI work product on two
   independent axes — **answer score** (what % of an advisor-quality
   deliverable did the model produce?) and **source score** (is every claim
   traceable?). This extends the existing extraction eval into a deliverable
   eval and turns "the AI writes good reports" into a measured, per-`prompt_version`
   discipline. Highest leverage per line of code.

3. **[03 — Sell-side workflow agents (Agent Builder analog)](./03-workflow-agents.md)**
   Harvey's "built by lawyers, tailored by you" → advisor-authored sell-side
   workflow agents. The deliverables studio, buyer lens, and diligence
   simulation are already agents-in-disguise; this generalizes them into a
   declarative, firm-tailorable workflow surface on top of the six-engine
   registry and the prompt registry, so a firm can encode *its* house process
   without a deploy.

## Suggested build order

The three are independent, but there's a natural sequence:

1. **02 (Bench) first, thin.** Before adding market data or new agents, make
   deliverable quality measurable. Everything below is safer to ship once a
   regression fails CI.
2. **01 (RAG) next.** The single biggest value-per-firm unlock, and it feeds
   both valuation (deterministic) and every market-facing deliverable
   (narrative). Start with the deterministic multiple table — it's the
   lowest-risk, highest-trust slice.
3. **03 (Workflow agents) last.** It productizes the pattern the first two
   establish and is the natural white-label surface for the advisor channel.

## What does *not* change

None of these touch the load-bearing rules. Scores stay deterministic and
versioned (rule #1). AI stays narrative-only and labeled draft (rule #2).
Methodology stays in data (rule #3). Firm isolation stays RLS-enforced (rule
#5) — licensed market data is *global reference data*, kept in its own
non-tenant schema and never mixed with a firm's proprietary corpus. Every new
artifact is versioned (rule #6).
