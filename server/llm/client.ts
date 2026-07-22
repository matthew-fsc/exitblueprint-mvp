// The single Claude client wrapper. Every LLM call in the platform goes through
// here so retry, timeout, and per-call cost logging are uniform and attributable.
// The transport is injectable: the default calls the Anthropic SDK, tests supply
// a fake. Nothing here computes a score (rule 2) — it moves text and logs cost.
import Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { getPrompt } from './prompts';
import { resolveProvider } from './provider';

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

// Default transport: the Anthropic SDK, pointed at whichever provider the
// environment selects (Vercel AI Gateway or the Anthropic API directly — see
// server/llm/provider.ts). Server-side only; keys are read from the environment
// and never shipped to a client.
export const anthropicTransport: LlmTransport = async (req) => {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error('LLM not configured: set AI_GATEWAY_API_KEY in the server environment');
  }
  const response = await provider.client.messages.create(
    {
      model: provider.modelFor(req.model),
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    },
    { signal: req.signal },
  );
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
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
