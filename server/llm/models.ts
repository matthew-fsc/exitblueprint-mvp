// Model tiers — a small, stable indirection so a prompt names a COST TIER, not a
// hard-coded model id. The three tiers map to concrete Anthropic model ids (the
// same ids priced in client.ts). 'economy' is the cheapest/free tier — used for
// mechanical, values-only work (e.g. structured extraction) where a large model
// would be waste; 'standard' and 'premium' are for graded narrative. Changing the
// concrete id behind a tier happens HERE, in one place, not at every call site.
export type ModelTier = 'economy' | 'standard' | 'premium';

const TIER_MODEL: Record<ModelTier, string> = {
  economy: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5',
  premium: 'claude-opus-4-8',
};

// The concrete Anthropic model id for a cost tier.
export function modelForTier(tier: ModelTier): string {
  return TIER_MODEL[tier];
}
