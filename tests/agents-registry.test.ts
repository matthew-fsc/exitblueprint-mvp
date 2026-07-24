// The agent registry (server/agents/registry.ts) is the declarative table of the
// workflow agents we ship today — the "name the pattern" slice of
// docs/sellside-ai/03. These tests are the VALUE of that slice: they hold the
// pattern honest so every future deliverable inherits the guardrails by
// construction. Pure and hermetic — no DB, no network. `promptFileKeys()` only
// reads the bundled prompts/ directory off disk (the same allow-list the prompt
// registry ships), and server/registry.ts's ENGINES/REGISTRY are plain in-memory
// tables, so importing them has no side effects.
import { describe, expect, it } from 'vitest';
import { AGENTS, getAgent } from '../server/agents/registry';
import { promptFileKeys } from '../server/prompt-registry';
import { ENGINES, REGISTRY } from '../server/registry';
import type { AgentGuard } from '../shared/agents/spec';

// The auth scopes actually in use by a compute endpoint. An agent's declared
// scope must be one of these — derived from the function registry so the two
// can't silently drift (a typo'd scope would fail here rather than at runtime).
const SCOPES_IN_USE = new Set(Object.values(REGISTRY).map((spec) => spec.scope));

describe('agent registry', () => {
  it('declares the agents that exist today', () => {
    expect(AGENTS.map((a) => a.key).sort()).toEqual(
      [
        'cim',
        'delta_report',
        'diligence_qa',
        'diligence_simulation',
        'engagement_graph_brief',
        'institutional_review',
        'management_presentation',
        'owner_report',
        'teaser',
      ].sort(),
    );
  });

  it('every agent declares a valid engine from the six-engine set', () => {
    for (const a of AGENTS) {
      expect(ENGINES, `${a.key} engine`).toContain(a.engine);
    }
  });

  it('every agent shipping today is a reasoning agent (draft-only narrative)', () => {
    // CLAUDE.md rules 1-2: these agents narrate FROM deterministic facts; none
    // computes a score. If a non-reasoning agent is added, this expectation is a
    // deliberate checkpoint to revisit the guard requirements below.
    for (const a of AGENTS) {
      expect(a.engine, `${a.key} engine`).toBe('reasoning');
    }
  });

  it('every agent declares a valid, non-empty scope that a real endpoint uses', () => {
    for (const a of AGENTS) {
      expect(typeof a.scope, `${a.key} scope type`).toBe('string');
      expect(a.scope.length, `${a.key} scope non-empty`).toBeGreaterThan(0);
      expect(SCOPES_IN_USE, `${a.key} scope is a real auth scope`).toContain(a.scope);
    }
  });

  it('every agent promptKey resolves to a bundled prompt file', () => {
    // The prompt registry's allow-list is the prompts/*.md filename stems; an
    // agent may only bind to a prompt that ships with the build (the payload↔field
    // contract has code behind it). Membership here is the executable form of that.
    const keys = new Set(promptFileKeys());
    for (const a of AGENTS) {
      expect(keys, `${a.key} promptKey '${a.promptKey}' must be a shipped prompt`).toContain(a.promptKey);
    }
  });

  it('every agent declares a promptVersion that resolves to a shipped prompt file', () => {
    // The generators source their persisted prompt_version FROM the spec's
    // promptVersion (server/narrative.ts, server/diligence-simulation.ts). It must
    // be non-empty and, like promptKey, resolve to a bundled prompt so the
    // system-prompt lookup and the payload↔field contract have code behind them.
    const keys = new Set(promptFileKeys());
    for (const a of AGENTS) {
      expect(typeof a.promptVersion, `${a.key} promptVersion type`).toBe('string');
      expect(a.promptVersion.length, `${a.key} promptVersion non-empty`).toBeGreaterThan(0);
      expect(keys, `${a.key} promptVersion '${a.promptVersion}' must be a shipped prompt`).toContain(
        a.promptVersion,
      );
    }
  });

  it('every agent declares a valid cost/capability model tier', () => {
    // CLAUDE.md cost discipline: the tier is data (server/llm/models.ts routes it to
    // a concrete model, re-pointable by env). Declaring it per-spec means a new
    // agent can't be added without a deliberate cost decision — and no agent can
    // name a tier the router doesn't know.
    const TIERS = new Set(['economy', 'standard', 'premium']);
    for (const a of AGENTS) {
      expect(TIERS, `${a.key} modelTier`).toContain(a.modelTier);
    }
  });

  it('every agent declares a rule-based model label', () => {
    // The generators stamp this label when the deterministic composer (not the AI)
    // produced the draft, so a reader can tell a rule-based document from an
    // AI-drafted one. Sourced FROM the spec; must carry the 'rule-based:' prefix —
    // or 'retrieval-only:' for the Q&A agent, whose deterministic fallback renders
    // the cited source evidence rather than a composed report (still non-AI).
    for (const a of AGENTS) {
      expect(typeof a.ruleBasedModel, `${a.key} ruleBasedModel type`).toBe('string');
      expect(a.ruleBasedModel, `${a.key} ruleBasedModel prefix`).toMatch(/^(rule-based|retrieval-only):/);
    }
  });

  it('every client-facing reasoning agent lists the numeral firewall and a draft label', () => {
    // The anti-hallucination floor + rule-2 draft gate are non-negotiable for any
    // agent that generates client-facing text. Declaring them per-spec means a new
    // deliverable can't be added without them.
    const REQUIRED: AgentGuard[] = ['numeral_firewall', 'draft_label'];
    for (const a of AGENTS) {
      for (const guard of REQUIRED) {
        expect(a.guards, `${a.key} guards`).toContain(guard);
      }
    }
  });

  it('agent keys are unique and match their promptKey stem', () => {
    const keys = AGENTS.map((a) => a.key);
    expect(new Set(keys).size, 'unique keys').toBe(keys.length);
    // The key is the prompt_version stem convention (e.g. key 'owner_report' ⇒
    // promptKey 'owner_report.v1'); lock that so the two never drift.
    for (const a of AGENTS) {
      expect(a.promptKey, `${a.key} promptKey stem`).toMatch(new RegExp(`^${a.key}\\.v\\d+$`));
    }
  });

  it('persist targets are the immutable snapshot tables or none (the read-only seam)', () => {
    for (const a of AGENTS) {
      expect(
        ['generated_documents', 'diligence_simulation_runs', 'diligence_qa', 'none'],
        `${a.key} persist`,
      ).toContain(a.persist);
    }
    // The narrative documents persist to generated_documents; the diligence
    // simulation writes a run; the institutional reviewer is read-only ('none').
    expect(getAgent('owner_report')?.persist).toBe('generated_documents');
    expect(getAgent('diligence_simulation')?.persist).toBe('diligence_simulation_runs');
    expect(getAgent('institutional_review')?.persist).toBe('none');
  });

  it('getAgent looks up by key and returns undefined for unknown keys', () => {
    expect(getAgent('cim')?.promptKey).toBe('cim.v1');
    expect(getAgent('not_an_agent')).toBeUndefined();
  });
});
