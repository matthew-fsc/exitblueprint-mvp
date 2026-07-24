// AgentSpec — the declarative form of the "workflow agent" runtime the narrative
// and diligence-simulation generators ALREADY follow (docs/sellside-ai/03).
//
// Read server/narrative.ts and server/diligence-simulation.ts through Harvey's
// "agent" lens and both are the same three-step shape:
//
//   1. buildPayload()   — assemble a read-only, DETERMINISTIC picture
//                         (KNOWLEDGE + RULES engines: scores, gaps, evidence).
//   2. pickNarrative()  — draft it, AI or the rule-based composer fallback
//                         (REASONING engine, DRAFT-ONLY — never a score).
//   3. persist+version  — write an immutable, prompt_version'd snapshot.
//
// That shared shape IS the agent runtime; it is just implicit, copied per
// document. This file names the pattern: an AgentSpec is the METADATA a new
// deliverable declares so it inherits the guardrails by construction rather than
// by remembering to copy them. It is deliberately NOT a generic agent framework
// — it mirrors how server/registry.ts made the function set declarative (the
// {engine, scope, gated, handler} table), applied to the reasoning deliverables.
//
// WHAT STAYS FIXED (and is therefore NOT expressed as editable spec fields):
//   * the deterministic engines — scoring, valuation, findings — are code
//     (CLAUDE.md rule 1). A spec declares its engine tag; it never supplies the
//     scorer.
//   * the numeral firewall (numeralPostCheck) and the draft label / advisor-
//     review gate are code, independent of prompt text (CLAUDE.md rule 2). A spec
//     LISTS the guards it is held to; it cannot weaken them.
// A spec is descriptive of a generator that already exists — a legend for the
// runtime — not a lever that reconfigures it. This slice is metadata only.

// ── Engines ────────────────────────────────────────────────────────────────────
// Mirrors the six-engine union in server/registry.ts (`ENGINES` / `Engine`),
// which realizes the platform-architecture engine model (docs/28 §6). Restated
// here rather than imported so `shared/` stays free of any `server/`-layer
// dependency (server imports shared, never the reverse). The strings must match
// server/registry.ts exactly; the registry test cross-checks membership. Every
// agent we ship today is a REASONING agent (draft-only narrative over
// deterministic facts) — the union carries all six so the taxonomy reads as
// complete and a future non-reasoning agent has an accurate tag to declare.
export type AgentEngine =
  | 'identity' // WHO & WHAT — the authorize/RLS gateway itself (never an agent)
  | 'knowledge' // WHAT WE KNOW — assessments, evidence, financials (the payload substrate)
  | 'workflow' // WHAT HAPPENS NEXT — engagement lifecycle & progression
  | 'rules' // THE FACTS — deterministic scoring, valuation, findings (rule 1)
  | 'reasoning' // THE EXPLANATION — AI narratives & assembled documents (draft-only)
  | 'collaboration'; // WHO PARTICIPATES — invites, review queue, verification hand-offs

// ── Output guards ──────────────────────────────────────────────────────────────
// The anti-hallucination / professional-liability floor an agent's output is held
// to. These name CODE checks that live in the generators and are independent of
// prompt text, so a prompt edit (or a future firm overlay) can never remove them.
// A spec LISTS the guards that apply; it does not implement or relax them.
export type AgentGuard =
  // Every numeral in the draft must already appear in the deterministic payload
  // (server/narrative.ts `numeralPostCheck`): one regeneration, then a hard
  // fail. This is the executable form of CLAUDE.md rule 2 — the model narrates,
  // it never authors a number.
  | 'numeral_firewall'
  // The output is unmissably labeled draft narrative for advisor review, never a
  // finished/authoritative document (CLAUDE.md rule 2). E.g. the diligence run's
  // DRAFT_BANNER; the composer's "built directly from your assessment answers"
  // framing on reports.
  | 'draft_label'
  // FUTURE (docs/sellside-ai/01): the citation contract that extends the numeral
  // firewall for market-facing claims — any sentence stating a market figure must
  // carry its source citation (`citationPostCheck`). Not built yet; listed on the
  // market/buyer-facing agents so the guard they will inherit is declared now.
  | 'citation_contract';

// ── The spec ───────────────────────────────────────────────────────────────────
// One agent == one AgentSpec. Adding a deliverable becomes one declaration whose
// fields are all read directly off the existing generator, so the engine tag, the
// prompt binding, and the guardrails can be verified in one place (tests/agents-
// registry.test.ts) instead of being re-derived by reading each generator.
export interface AgentSpec {
  // The agent's identity and prompt_version stem — the convention the generators
  // already use (e.g. narrative.ts's PROMPT_VERSION 'owner_report.v1' has the
  // stem 'owner_report'; diligence-simulation's is 'diligence_simulation').
  // Unique across the registry.
  key: string;
  // Which of the six engines the agent belongs to (docs/28 §6). Today always
  // 'reasoning': every agent drafts narrative FROM deterministic facts and never
  // computes a score.
  engine: AgentEngine;
  // The registry auth scope the agent's invocation is gated by, matching the
  // `AuthScope` strings in server/registry.ts (e.g. 'assessment' for the
  // assessment-scoped document generators). Declared so the agent's authorization
  // boundary is legible next to its other metadata.
  scope: string;
  // The prompts/<promptKey>.md filename stem the agent's AI path resolves via the
  // prompt registry (server/prompt-registry.ts). Equals `${key}.v1` today — the
  // versioned base prompt. Must resolve to a bundled prompt file (the allow-list),
  // which the registry test asserts.
  promptKey: string;
  // The prompt_version the generator resolves its system prompt with AND stamps on
  // the persisted, immutable snapshot (rule 6). This is the value each generator
  // formerly held as a local PROMPT_VERSION constant (e.g. narrative.ts's
  // 'owner_report.v1', diligence-simulation.ts's 'diligence_simulation.v1'); it is
  // sourced here so the registry is the single source of truth for the persisted
  // prompt_version. Equals promptKey today — the versioned base prompt — and, like
  // it, must resolve to a bundled prompt file (the registry test asserts both).
  promptVersion: string;
  // The model label written to the snapshot when the DETERMINISTIC composer (not
  // the AI) produced the draft, so a reader can always tell a rule-based document
  // from an AI-drafted one. Always the 'rule-based:<promptVersion>' form each
  // generator formerly held as a local RULE_BASED_MODEL constant. Never the API
  // model id — that names an AI call, which is a generator concern, not spec.
  ruleBasedModel: string;
  // The output guards this agent's draft is held to (see AgentGuard). Every
  // client-facing reasoning agent lists 'numeral_firewall' and 'draft_label';
  // market/buyer-facing ones additionally list the (future) 'citation_contract'.
  guards: AgentGuard[];
  // Where the immutable, versioned snapshot is written. The narrative deliverables
  // persist to generated_documents (a narrative table — rule 2: AI never writes to
  // scoring tables); the diligence simulation persists a run to its own table.
  // 'none' is the read-only reviewer seam (institutional_review): it returns an
  // in-memory labeled draft and writes to no table (persisting it is a follow-up
  // that needs its own migration), so it declares no persistence target.
  persist: 'generated_documents' | 'diligence_simulation_runs' | 'none';
  // One-line human description of the work product, for the registry readout.
  describe: string;
}
