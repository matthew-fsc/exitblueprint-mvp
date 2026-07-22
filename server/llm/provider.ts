// The single place that decides HOW we reach Claude and WHETHER we are
// configured to. Every LLM call in the platform (narrative, institutional
// review, extraction, findings) resolves its client here so the wiring is
// uniform and there is exactly one fallback contract.
//
// Two ways in, checked in order:
//   1. AI_GATEWAY_API_KEY  → Vercel AI Gateway (Anthropic-compatible Messages
//      API). The SDK points at the gateway base URL and the model id is
//      namespaced with the `anthropic/` provider prefix and a dotted version
//      (Vercel's slug convention: claude-opus-4-8 → anthropic/claude-opus-4.8).
//   2. ANTHROPIC_API_KEY   → the Anthropic API directly (SDK defaults).
//
// Neither set → not configured; callers fall back to their deterministic
// composer (CLAUDE.md rule 1/2 safe) so a document always generates. This is
// what makes the "no money in the account" case seamless: an empty gateway
// balance surfaces as an API error at call time, callers catch it and compose
// the rule-based artifact instead of failing (see aiFailureReason).
import Anthropic from '@anthropic-ai/sdk';

// Vercel AI Gateway, Anthropic Messages API compatibility endpoint. The SDK
// appends `/v1/messages`, so this is the bare host (no `/v1`).
const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh';

export interface NarrativeProvider {
  client: Anthropic;
  // Maps a first-party Anthropic model id to the id this provider expects.
  modelFor: (model: string) => string;
  // For logs/telemetry only — never stored on a document.
  transport: 'gateway' | 'direct';
}

const nonEmpty = (v: string | undefined): boolean => Boolean(v && v.trim());

// True when the AI narrative path is wired at all (gateway OR direct key). When
// false, callers use their deterministic composer without ever touching the API.
export function aiConfigured(): boolean {
  return nonEmpty(process.env.AI_GATEWAY_API_KEY) || nonEmpty(process.env.ANTHROPIC_API_KEY);
}

// claude-opus-4-8 → anthropic/claude-opus-4.8 (Vercel AI Gateway slug). Already
// namespaced ids pass through untouched.
export function toGatewayModel(model: string): string {
  if (model.includes('/')) return model;
  const slug = model.replace(/-(\d+)-(\d+)(?=$|-)/, '-$1.$2');
  return `anthropic/${slug}`;
}

// Build the client the current environment selects, or null if unconfigured.
// The gateway is preferred when both are present so a deploy can move traffic
// onto the gateway just by setting AI_GATEWAY_API_KEY.
export function resolveProvider(): NarrativeProvider | null {
  if (nonEmpty(process.env.AI_GATEWAY_API_KEY)) {
    return {
      client: new Anthropic({
        apiKey: process.env.AI_GATEWAY_API_KEY,
        baseURL: GATEWAY_BASE_URL,
      }),
      modelFor: toGatewayModel,
      transport: 'gateway',
    };
  }
  if (nonEmpty(process.env.ANTHROPIC_API_KEY)) {
    return { client: new Anthropic(), modelFor: (m) => m, transport: 'direct' };
  }
  return null;
}

// A short, human-readable reason for an AI-call failure, for the fallback log.
// The "no money" case (empty gateway balance / exhausted credit) is called out
// explicitly so an operator reading the logs knows to top up rather than debug.
export function aiFailureReason(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const message = (err as { message?: string })?.message ?? String(err);
  if (status === 402 || /\b(credit|billing|payment|insufficient|quota|balance|fund)/i.test(message)) {
    return `no available credit / billing (${status ?? 'error'})`;
  }
  if (status === 401 || status === 403) return `auth rejected (${status})`;
  if (status === 429) return 'rate limited (429)';
  if (typeof status === 'number') return `API error (${status})`;
  return message;
}
