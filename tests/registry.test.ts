// The function registry is the structural spine of the compute layer: every
// `/functions/v1/<name>` endpoint declares its engine, auth scope, billing gate,
// and handler in one place (server/registry.ts). These tests hold that structure
// honest — they are pure (no DB) and guard the invariants that make the six-engine
// model inevitable rather than aspirational.
import { describe, expect, it } from 'vitest';
import { ENGINES, REGISTRY, gatedFunctionNames, type AuthScope, type Engine } from '../server/registry';
import { GATED_FNS } from '../server/entitlements';

const VALID_SCOPES: AuthScope[] = [
  'firm',
  'create-engagement',
  'delete-engagement',
  'export-engagement',
  'document-upload',
  'review-queue',
  'document',
  'sellside-engagement',
  'sellside-item',
  'ledger-connect',
  'ledger-complete',
  'engagement',
  'manage-engagement',
  'assessment',
  'platform-admin',
];

describe('function registry', () => {
  const entries = Object.entries(REGISTRY);

  it('has entries', () => {
    expect(entries.length).toBeGreaterThan(30);
  });

  it('every function declares a valid engine, scope, and handler', () => {
    for (const [name, spec] of entries) {
      expect(ENGINES, `${name} engine`).toContain(spec.engine);
      expect(VALID_SCOPES, `${name} scope`).toContain(spec.scope);
      expect(typeof spec.handler, `${name} handler`).toBe('function');
      // `gated` is optional but, when present, must be a boolean flag.
      if ('gated' in spec) expect(typeof spec.gated).toBe('boolean');
    }
  });

  it('Identity is the gateway, not an endpoint — no function is tagged identity', () => {
    // Identity (authn/authz/tenancy) is the authorize layer in functions.ts + RLS,
    // so it owns zero endpoints. Every other engine carries real work.
    const byEngine = new Map<Engine, number>();
    for (const [, spec] of entries) byEngine.set(spec.engine, (byEngine.get(spec.engine) ?? 0) + 1);
    expect(byEngine.get('identity') ?? 0).toBe(0);
    for (const engine of ['knowledge', 'workflow', 'rules', 'reasoning', 'collaboration'] as Engine[]) {
      expect(byEngine.get(engine) ?? 0, `${engine} endpoints`).toBeGreaterThan(0);
    }
  });

  it('the billing gate reads the registry — GATED_FNS === the gated functions', () => {
    // Single source of truth: entitlements.ts derives its paid-action set from the
    // registry's `gated` flags. If these drift, a paid action silently became free
    // (or vice versa).
    expect([...GATED_FNS].sort()).toEqual(gatedFunctionNames().sort());
  });

  it('exactly the paid actions are gated (viewing existing data is never gated)', () => {
    // Locks the paid surface (docs/24 §5.3): actions that produce new work /
    // deliverables. A change here should be deliberate, not incidental.
    expect(gatedFunctionNames().sort()).toEqual(
      [
        'apply-plan',
        'compute-valuation',
        'create-engagement',
        'generate-document',
        'generate-roadmap',
        'invite-owner',
        'render-cim-pdf',
        'render-delta-pdf',
        'render-owner-pdf',
        'score-assessment',
      ].sort(),
    );
  });

  it('function names are unique and kebab-case', () => {
    for (const name of Object.keys(REGISTRY)) {
      expect(name, name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
