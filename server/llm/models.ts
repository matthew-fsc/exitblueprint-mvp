// Model tiering / cost routing (CLAUDE.md cost discipline: don't overspend on
// simple tasks). ONE place that maps a coarse capability TIER to a concrete
// gateway model id, so a caller declares "how much brain does this task need"
// instead of hardcoding a model. Every reasoning agent declares a `modelTier` in
// its AgentSpec (shared/agents/spec.ts); the extraction / eval callers pass a tier
// here directly.
//
// RULE ALIGNMENT. This decides WHICH model drafts narrative; it never lets a model
// compute a score (rule 1) or author a number (rule 2 — the numeral firewall in
// server/intelligence/guards.ts is model-independent and runs regardless of tier).
// Tier→model is data and is overridable per-tier by env WITHOUT a deploy (rule 3
// spirit), so ops can re-point a tier — swap the free model, pin a version — from
// configuration, and roll it back the same way.
//
// The tier slugs are gateway model ids passed straight to server/llm/provider.ts's
// toGatewayModel: a `claude-*` id is namespaced (→ anthropic/claude-…); an already-
// namespaced id (e.g. 'inclusionai/ling-3.0-flash-free') passes through untouched.

export type ModelTier = 'economy' | 'standard' | 'premium';

// The three tiers, cheapest first — the iteration order tests and docs rely on.
export const MODEL_TIERS: readonly ModelTier[] = ['economy', 'standard', 'premium'] as const;

// Default tier → model id.
//   economy  — free / near-free; simple structured or classification-style work
//              (document extraction, the Bench LLM-judge, tool routing). The free
//              gateway model handles these without paying for a frontier model.
//   standard — cheap, capable; advisor-facing internal drafts and moderate synthesis.
//   premium  — top capability; client-/buyer-facing polished deliverables where the
//              quality is worth the spend.
const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  economy: 'inclusionai/ling-3.0-flash-free',
  standard: 'claude-haiku-4-5-20251001',
  premium: 'claude-opus-4-8',
};

// The tier a caller gets when it declares none — the safe, highest-capability
// default, so an unspecified path never silently downgrades.
export const DEFAULT_MODEL_TIER: ModelTier = 'premium';

// Per-tier env override key. Set AI_MODEL_ECONOMY / AI_MODEL_STANDARD /
// AI_MODEL_PREMIUM to a gateway model id to re-point a tier without a deploy.
const ENV_KEY: Record<ModelTier, string> = {
  economy: 'AI_MODEL_ECONOMY',
  standard: 'AI_MODEL_STANDARD',
  premium: 'AI_MODEL_PREMIUM',
};

// Resolve a tier to the concrete gateway model id, honoring an env override. A
// blank/whitespace override is ignored (treated as unset) so an empty env var can
// never resolve to an empty model id.
export function modelForTier(tier: ModelTier = DEFAULT_MODEL_TIER): string {
  const override = process.env[ENV_KEY[tier]];
  if (override && override.trim()) return override.trim();
  return DEFAULT_TIER_MODELS[tier];
}
