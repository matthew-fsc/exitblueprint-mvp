// The single place that decides HOW we reach Claude and WHETHER we are
// configured to. Every LLM call in the platform (narrative, institutional
// review, extraction, findings) resolves its client here so the wiring is
// uniform and there is exactly one fallback contract.
//
// One way in: AI_GATEWAY_API_KEY → the Vercel AI Gateway (Anthropic-compatible
// Messages API). We reach Anthropic *through* Vercel; there is no separate
// Anthropic key. The SDK points at the gateway base URL and the model id is
// namespaced with the `anthropic/` provider prefix and a dotted version
// (Vercel's slug convention: claude-opus-4-8 → anthropic/claude-opus-4.8).
//
// Unset → not configured; callers fall back to their deterministic composer
// (CLAUDE.md rule 1/2 safe) so a document always generates. This is also what
// makes the "no money in the account" case seamless: an empty gateway balance
// surfaces as an API error at call time, callers catch it and compose the
// rule-based artifact instead of failing (see aiFailureReason).
import Anthropic from '@anthropic-ai/sdk';

// Vercel AI Gateway, Anthropic Messages API compatibility endpoint. The SDK
// appends `/v1/messages`, so this is the bare host (no `/v1`).
const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh';

export interface NarrativeProvider {
  client: Anthropic;
  // Maps a first-party Anthropic model id to the gateway's namespaced slug.
  modelFor: (model: string) => string;
}

const nonEmpty = (v: string | undefined): boolean => Boolean(v && v.trim());

// True when the AI narrative path is wired (the gateway key is present). When
// false, callers use their deterministic composer without ever touching the API.
export function aiConfigured(): boolean {
  return nonEmpty(process.env.AI_GATEWAY_API_KEY);
}

// claude-opus-4-8 → anthropic/claude-opus-4.8 (Vercel AI Gateway slug). Already
// namespaced ids pass through untouched.
export function toGatewayModel(model: string): string {
  if (model.includes('/')) return model;
  const slug = model.replace(/-(\d+)-(\d+)(?=$|-)/, '-$1.$2');
  return `anthropic/${slug}`;
}

// Build the gateway client, or null if unconfigured.
export function resolveProvider(): NarrativeProvider | null {
  if (!nonEmpty(process.env.AI_GATEWAY_API_KEY)) return null;
  return {
    client: new Anthropic({
      apiKey: process.env.AI_GATEWAY_API_KEY,
      baseURL: GATEWAY_BASE_URL,
    }),
    modelFor: toGatewayModel,
  };
}

// ── The one Messages request builder ────────────────────────────────────────────
// Every LLM call in the platform — the narrative runtime (server/intelligence/
// runtime.ts), the advisor copilot (server/copilot.ts), and the extraction/findings
// client (server/llm/client.ts) — goes through this ONE function, so the request
// shape can never drift call-site to call-site. It is plain generation: NO extended
// `thinking` config (an adaptive-thinking response can come back with only a thinking
// block and no text, which starves every caller of output — the "0 output tokens"
// failure). The model id is namespaced to the gateway slug here; callers pass the
// first-party id.
export interface CreateMessageRequest {
  model: string;
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  system?: string;
  tools?: Anthropic.Tool[];
  signal?: AbortSignal;
  // A model to retry with when the primary `model` is one the gateway can't serve for
  // this account (an access error — see isModelAccessError). Callers pass the premium
  // tier here so a cheap-tier model the gateway routes to a provider the account lacks
  // (e.g. Haiku → Vertex AI → 403) transparently upgrades to a served model instead of
  // failing the whole call to a composer/retrieval fallback. Omit to disable.
  fallbackModel?: string;
}

// A model-ACCESS error: the gateway can't serve the requested model for this account —
// not authorized / not found on whichever upstream provider it routed to (401/403/404).
// Retrying the SAME model won't help (unlike a transient 429/5xx), but a DIFFERENT model
// the account CAN reach may succeed. This is the "Haiku routed to Vertex AI → 403" case.
export function isModelAccessError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 401 || status === 403 || status === 404;
}

export async function createMessage(req: CreateMessageRequest): Promise<Anthropic.Message> {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error('AI is not configured: set AI_GATEWAY_API_KEY in the server environment');
  }
  const send = (model: string) =>
    provider.client.messages.create(
      {
        model: provider.modelFor(model),
        max_tokens: req.maxTokens,
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.tools ? { tools: req.tools } : {}),
        messages: req.messages,
      },
      req.signal ? { signal: req.signal } : undefined,
    );
  try {
    return await send(req.model);
  } catch (err) {
    // A cheap-tier model the gateway can't serve → upgrade once to the served fallback,
    // rather than failing the call. Only for access errors, and only when the fallback
    // is a DIFFERENT model (never retry the same id).
    if (req.fallbackModel && req.fallbackModel !== req.model && isModelAccessError(err)) {
      console.warn(
        `AI model '${req.model}' is not served by the gateway for this account ` +
          `(${(err as { status?: number }).status}); retrying with '${req.fallbackModel}'. ` +
          'Set AI_MODEL_* to a served model to avoid the extra call.',
      );
      return send(req.fallbackModel);
    }
    throw err;
  }
}

// The concatenated text of a message's text blocks — the standard "give me the answer
// text" read, shared so every caller extracts text identically (tool_use / thinking
// blocks are ignored). Empty string when the model returned no text block.
export function messageText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
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
