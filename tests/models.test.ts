// Model tiering / cost routing (server/llm/models.ts). Pure and hermetic: the only
// state is process.env, which each test sets and restores. Locks the two properties
// the cost-discipline seam relies on — the default tier→model table (so the free
// economy model is actually what economy resolves to) and the env-override contract
// (so ops can re-point a tier without a deploy, and a blank override never wins).
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_TIER, MODEL_TIERS, modelForTier, type ModelTier } from '../server/llm/models';

const ENV_KEYS = ['AI_MODEL_ECONOMY', 'AI_MODEL_STANDARD', 'AI_MODEL_PREMIUM'] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('model tier routing', () => {
  it('exposes the three tiers cheapest-first', () => {
    expect([...MODEL_TIERS]).toEqual(['economy', 'standard', 'premium']);
  });

  it('defaults to premium so an unspecified caller never silently downgrades', () => {
    expect(DEFAULT_MODEL_TIER).toBe('premium');
    // Called with no argument resolves the default tier.
    expect(modelForTier()).toBe(modelForTier('premium'));
  });

  it('maps economy to the free model, and every tier to a non-empty id', () => {
    expect(modelForTier('economy')).toBe('inclusionai/ling-3.0-flash-free');
    for (const tier of MODEL_TIERS) {
      expect(modelForTier(tier as ModelTier).length, `${tier} model`).toBeGreaterThan(0);
    }
  });

  it('premium stays a frontier model and standard a cheaper one (distinct tiers)', () => {
    const models = new Set(MODEL_TIERS.map((t) => modelForTier(t as ModelTier)));
    // Three tiers must resolve to three distinct models by default — a collision
    // would mean a tier is not actually saving anything.
    expect(models.size).toBe(3);
  });

  it('honors a per-tier env override, and ignores a blank one', () => {
    process.env.AI_MODEL_ECONOMY = 'someprovider/cheaper-model';
    expect(modelForTier('economy')).toBe('someprovider/cheaper-model');

    // A whitespace-only override is treated as unset (never resolves to empty).
    process.env.AI_MODEL_STANDARD = '   ';
    expect(modelForTier('standard')).toBe('claude-haiku-4-5-20251001');
  });
});
