// The agent registry — the declarative table of the workflow agents that exist
// TODAY (docs/sellside-ai/03, "Move 1 — name the pattern"). Each entry is the
// metadata for one generator already implemented in server/narrative.ts or
// server/diligence-simulation.ts; nothing here calls or reconfigures those
// generators. This is the reasoning-engine analog of server/registry.ts: the same
// "make the implicit structure a property of the code" move, applied to the
// draft-narrative deliverables.
//
// Every field is read directly off the real generator (the prompt_version
// constants, the prompt file stems, the persist tables, the guards each honors),
// so tests/agents-registry.test.ts can hold the pattern honest — valid engine,
// valid scope, a promptKey that resolves to a shipped prompt file, the firewall
// present on every client-facing agent — without re-reading each generator by
// hand. Adding a future deliverable means adding one spec here and inheriting
// those invariants by construction.
//
// METADATA ONLY: this module intentionally does NOT import server/narrative.ts or
// server/diligence-simulation.ts. The generators remain the single source of
// runtime behavior (this slice is 100% non-breaking); the registry is a legend
// for them, not a second implementation.
import type { AgentSpec } from '../../shared/agents/spec';

// The agents shipping today. All are REASONING agents: each assembles a
// deterministic payload (KNOWLEDGE + RULES), drafts narrative over it (draft-only,
// numeral-firewalled), and either persists an immutable, prompt_version'd snapshot
// or (the reviewer seam) returns an in-memory labeled draft.
//
// Scopes are taken from the real invocations in server/registry.ts:
//   * the five narrative documents are produced through `generate-document` /
//     `render-*-pdf`, all scope 'assessment' (assessment-scoped, gated).
//   * the diligence simulation is PRODUCED through `simulate-diligence`, scope
//     'manage-engagement' (a firm-staff write; the read counterpart
//     `diligence-simulation` is engagement-scoped, but the agent's work-producing
//     invocation is the write).
//   * institutional_review is the read-only reviewer seam (server/institutional-
//     review.ts) that diligence reuses; it is not yet exposed as its own endpoint,
//     so it declares the assessment scope its payload is built under and persist
//     'none' (it writes to no table).
export const AGENTS: AgentSpec[] = [
  {
    key: 'owner_report',
    engine: 'reasoning',
    scope: 'assessment',
    promptKey: 'owner_report.v1',
    promptVersion: 'owner_report.v1',
    ruleBasedModel: 'rule-based:owner_report.v1',
    // Client-facing readout of the owner's own scores/gaps — numeral firewall +
    // draft label. Not market-facing, so no citation contract.
    guards: ['numeral_firewall', 'draft_label'],
    persist: 'generated_documents',
    describe: 'Owner-facing exit readiness report drafted from the assessment scores and top gaps.',
  },
  {
    key: 'delta_report',
    engine: 'reasoning',
    scope: 'assessment',
    promptKey: 'delta_report.v1',
    promptVersion: 'delta_report.v1',
    ruleBasedModel: 'rule-based:delta_report.v1',
    // Client-facing progress artifact (delta vs. prior, or a baseline). Same
    // firewall + draft label; not market-facing.
    guards: ['numeral_firewall', 'draft_label'],
    persist: 'generated_documents',
    describe: 'Quarterly progress report drafted from the deterministic comparison against the prior assessment.',
  },
  {
    key: 'cim',
    engine: 'reasoning',
    scope: 'assessment',
    promptKey: 'cim.v1',
    promptVersion: 'cim.v1',
    ruleBasedModel: 'rule-based:cim.v1',
    // Buyer/market-facing marketing document. 'citation_contract' is listed as a
    // FUTURE guard (docs/sellside-ai/01, not built yet) — declared here so the
    // market-facing agent inherits it the moment citationPostCheck ships.
    guards: ['numeral_firewall', 'draft_label', 'citation_contract'],
    persist: 'generated_documents',
    describe: 'Confidential Information Memorandum drafted from the strengths-only, verified-facts payload.',
  },
  {
    key: 'teaser',
    engine: 'reasoning',
    scope: 'assessment',
    promptKey: 'teaser.v1',
    promptVersion: 'teaser.v1',
    ruleBasedModel: 'rule-based:teaser.v1',
    // Buyer/market-facing (anonymized blind profile). 'citation_contract' is the
    // same FUTURE guard as the CIM.
    guards: ['numeral_firewall', 'draft_label', 'citation_contract'],
    persist: 'generated_documents',
    describe: 'Anonymized blind-profile teaser drafted from the CIM strengths-only payload.',
  },
  {
    key: 'management_presentation',
    engine: 'reasoning',
    scope: 'assessment',
    promptKey: 'management_presentation.v1',
    promptVersion: 'management_presentation.v1',
    ruleBasedModel: 'rule-based:management_presentation.v1',
    // Buyer/market-facing (management-meeting narrative). 'citation_contract' is
    // the same FUTURE guard as the CIM.
    guards: ['numeral_firewall', 'draft_label', 'citation_contract'],
    persist: 'generated_documents',
    describe: 'Management presentation narrative drafted from the CIM strengths-only payload.',
  },
  {
    key: 'diligence_simulation',
    engine: 'reasoning',
    scope: 'manage-engagement',
    promptKey: 'diligence_simulation.v1',
    promptVersion: 'diligence_simulation.v1',
    ruleBasedModel: 'rule-based:diligence_simulation.v1',
    // Advisor-facing diligence rehearsal (DRAFT_BANNER is the draft label; the
    // findings and their severity are deterministic, the model only frames them).
    // Not market-facing, so no citation contract.
    guards: ['numeral_firewall', 'draft_label'],
    persist: 'diligence_simulation_runs',
    describe: 'Ranked, severity-keyed diligence blind-spot simulation persisted as an immutable run.',
  },
  {
    key: 'institutional_review',
    engine: 'reasoning',
    scope: 'assessment',
    promptKey: 'institutional_review.v1',
    promptVersion: 'institutional_review.v1',
    ruleBasedModel: 'rule-based:institutional_review.v1',
    // Advisor-facing reviewer seam (DRAFT_BANNER is the draft label; every figure
    // is the deterministic engine's, the model only frames the three lenses). Not
    // market-facing, so no citation contract.
    guards: ['numeral_firewall', 'draft_label'],
    // Read-only: returns an in-memory labeled draft and writes to no table (see the
    // 'none' note on AgentSpec.persist). Sourcing its prompt_version / rule-based
    // model FROM this entry is what removed institutional-review.ts's literals.
    persist: 'none',
    describe: 'Read-only institutional review surfacing blind spots, missing evidence, and likely diligence questions as a labeled draft.',
  },
  {
    key: 'diligence_qa',
    engine: 'reasoning',
    scope: 'manage-engagement',
    promptKey: 'diligence_qa.v1',
    promptVersion: 'diligence_qa.v1',
    // The rule-based label is 'retrieval-only:' rather than 'rule-based:' because a
    // free-form answer cannot be composed rule-based; the deterministic fallback
    // renders the ranked, cited source evidence instead (docs/sellside-ai/05 §4).
    // It is still a non-AI, deterministic composer — the label just names the
    // honest degradation. `mode` is derived by comparing the run's model to this.
    ruleBasedModel: 'retrieval-only:diligence_qa.v1',
    // Answers a buyer's diligence question FROM the engagement's own cited facts:
    // numeral firewall + citation contract (every retrieved figure carries its
    // [cite_id]) + draft label (advisor-reviewed).
    guards: ['numeral_firewall', 'citation_contract', 'draft_label'],
    persist: 'diligence_qa',
    describe: 'Buyer diligence-question answer drafted from the engagement\'s own cited knowledge, degrading to retrieval-only when AI is unavailable.',
  },
];

// Look up an agent by its key (prompt_version stem). Returns undefined for an
// unknown key — the caller decides whether that is an error.
export function getAgent(key: string): AgentSpec | undefined {
  return AGENTS.find((a) => a.key === key);
}

// Look up an agent by key, throwing on an unknown one. The generators use this to
// source their prompt_version / rule-based-model label FROM the registry: the key
// is a fixed literal owned by the generator, so a miss is a programming error
// (a renamed/removed spec) that should fail loudly at module load, not a runtime
// branch. Keeps the registry the single source of truth for those values.
export function getAgentOrThrow(key: string): AgentSpec {
  const agent = getAgent(key);
  if (!agent) throw new Error(`unknown agent key: ${key}`);
  return agent;
}
