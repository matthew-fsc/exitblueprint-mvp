// The single Claude client wrapper. Every LLM call in the platform goes through
// here so retry, timeout, and per-call cost logging are uniform and attributable.
// The transport is injectable: the default calls the Anthropic SDK, tests supply
// a fake. Nothing here computes a score (rule 2) — it moves text and logs cost.
import type pg from 'pg';
import { getPrompt } from './prompts';
import { createMessage, messageText } from './provider';
import { modelForTier } from './models';

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}
export interface LlmResponse {
  text: string;
  model: string;
  usage: LlmUsage;
}
export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}
export type LlmTransport = (req: LlmRequest) => Promise<LlmResponse>;

// USD per million tokens. Unknown models fall back to the opus rate so cost is
// never silently zero; update when pricing changes.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // The economy-tier free model (server/llm/models.ts): no per-token charge, so
  // the llm_calls ledger records $0 for work routed to it — the cost win is
  // visible, not hidden behind the opus fallback rate.
  'inclusionai/ling-3.0-flash-free': { input: 0, output: 0 },
};
const FALLBACK_PRICE = PRICING['claude-opus-4-8'];

export function costUsd(model: string, usage: LlmUsage): number {
  const price = PRICING[model] ?? FALLBACK_PRICE;
  const cost =
    (usage.input_tokens / 1_000_000) * price.input +
    (usage.output_tokens / 1_000_000) * price.output;
  // Round to 6 decimals (micro-dollars); avoids float noise in the ledger.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// Default transport: the shared createMessage (server/llm/provider.ts) so the
// extraction/findings path builds its request exactly like the narrative runtime and
// the copilot — one request shape, no per-call-site drift. Server-side only; keys are
// read from the environment and never shipped to a client.
export const anthropicTransport: LlmTransport = async (req) => {
  const response = await createMessage({
    model: req.model,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    maxTokens: req.maxTokens,
    signal: req.signal,
    // If the gateway can't serve this prompt's (economy/standard) model for the account,
    // upgrade to premium rather than failing extraction outright.
    fallbackModel: modelForTier('premium'),
  });
  const text = messageText(response);
  return {
    text,
    model: response.model,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
};

export interface LlmCallOptions {
  promptKey: string;
  vars: Record<string, unknown>;
  firmId?: string | null;
  engagementId?: string | null;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface LlmCallResult extends LlmResponse {
  cost_usd: number;
  latency_ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A transient error is worth retrying: timeouts, rate limits, and 5xx. A 4xx
// (other than 429) is a bad request and is not retried.
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const name = (err as { name?: string })?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export class LlmClient {
  private readonly transport: LlmTransport;
  private readonly db?: pg.ClientBase;

  // db is the service-role client used to write the llm_calls ledger. Optional so
  // the client can run in a context without a DB (evals); cost is still returned.
  constructor(opts: { transport?: LlmTransport; db?: pg.ClientBase } = {}) {
    this.transport = opts.transport ?? anthropicTransport;
    this.db = opts.db;
  }

  async call(opts: LlmCallOptions): Promise<LlmCallResult> {
    const prompt = getPrompt(opts.promptKey);
    const user = prompt.render(opts.vars);
    const maxTokens = opts.maxTokens ?? 4096;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const maxRetries = opts.maxRetries ?? 3;

    const started = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.transport({
          model: prompt.model,
          system: prompt.system,
          user,
          maxTokens,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const latency_ms = Date.now() - started;
        const cost_usd = costUsd(res.model, res.usage);
        // Cost logging is best-effort: a ledger-write failure must not discard a
        // completion the caller already paid for.
        try {
          await this.logCall(opts, prompt.key, res, cost_usd, latency_ms);
        } catch (logErr) {
          console.warn(`llm_calls ledger write failed: ${(logErr as Error).message}`);
        }
        return { ...res, cost_usd, latency_ms };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < maxRetries && isTransient(err)) {
          await sleep(2 ** attempt * 250); // 250ms, 500ms, 1s backoff
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private async logCall(
    opts: LlmCallOptions,
    promptKey: string,
    res: LlmResponse,
    cost_usd: number,
    latency_ms: number,
  ): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      `insert into llm_calls
         (firm_id, engagement_id, prompt_key, model, input_tokens, output_tokens, cost_usd, latency_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        opts.firmId ?? null,
        opts.engagementId ?? null,
        promptKey,
        res.model,
        res.usage.input_tokens,
        res.usage.output_tokens,
        cost_usd,
        latency_ms,
      ],
    );
  }
}
