// The advisor copilot (WS-COPILOT): a READ-ONLY natural-language assistant over the
// firm's own book. It runs a BOUNDED Anthropic tool-use loop over the curated,
// read-only tool surface (server/copilot-tools.ts) and returns a DRAFT-LABELED
// synthesis. It is NOT an AgentSpec and NOT a single-shot runGroundedGeneration
// caller — it is a multi-turn tool loop — and it is v1 STATELESS (nothing persists,
// no migration).
//
// CLAUDE.md rules 1 & 2 hold here as CODE, the same way the deliverables path holds
// them:
//   * Numbers only from tool output. Every tool result is stringified and
//     concatenated into one payload; the answer is run through the SAME numeral
//     firewall (numeralPostCheck) the intelligence runtime uses — one regeneration
//     on a violation, then fail (→ graceful fallback). The model never authors a
//     figure that a read tool did not return.
//   * AI is narrative-only and labeled draft. No tool writes; every tool maps to an
//     ungated registry read (enforced in copilot-tools.ts). The answer carries a
//     draft banner and a draft flag.
//
// GRACEFUL DEGRADATION (mirrors diligence-qa's retrieval-only fallback spirit). When
// AI is unconfigured, or the tool-use loop fails / can't be grounded, the copilot
// degrades to a deterministic "AI unavailable — here are the raw tool results"
// response: it runs the firm-scoped read tools directly and renders their output for
// the advisor to read, stamped so a reader can tell it apart from an AI synthesis.
import type pg from 'pg';
import type Anthropic from '@anthropic-ai/sdk';
import { resolveProvider, aiFailureReason } from './llm/provider';
import { modelForTier } from './llm/models';
import { numeralPostCheck } from './intelligence/guards';
import { resolvePromptBody } from './prompt-registry';
import { COPILOT_TOOLS, ensureReadOnlyTools, toolDefinitions, type CopilotTool } from './copilot-tools';

// The prompt_version the AI path resolves its system prompt with and stamps on the
// answer (rule 6). Bundled at prompts/advisor_copilot.v1.md; superadmin-overridable
// through the prompt registry like every other prompt.
export const PROMPT_VERSION = 'advisor_copilot.v1';

// The model label stamped when the deterministic (no-AI) fallback produced the
// answer, so a reader can tell it apart from an AI synthesis (mirrors diligence-qa's
// RULE_BASED_MODEL).
export const UNAVAILABLE_MODEL = 'unavailable:advisor_copilot.v1';

// Synthesis model. Routed through the model-tier router (server/llm/models.ts) at
// the 'standard' tier — the same loop drives tool selection and synthesis, so there
// is one model. Re-pointable per-tier via the AI_MODEL_STANDARD env override with no
// deploy (CLAUDE.md cost discipline). resolveProvider().modelFor namespaces it to
// the gateway slug at call time.
const SYNTHESIS_MODEL = modelForTier('standard');

// Bound the loop so a misbehaving model can never spin: at most this many model
// round-trips (each may request one or more tools), then a forced synthesis turn.
const MAX_ITERATIONS = 5;
const MAX_TOKENS = 4096;

const DRAFT_BANNER = '_Draft — advisor copilot. Read-only; not legal, tax, or accounting advice._';

// One model round-trip in the loop. Injectable so tests drive the loop with a fake
// transport and no network; the default wraps the resolved gateway client.
export interface CopilotTurn {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  max_tokens: number;
}
export type CopilotTransport = (turn: CopilotTurn) => Promise<Anthropic.Message>;

export interface CopilotResult {
  question: string;
  answer_md: string;
  // 'ai' — synthesized by the tool-use loop; 'unavailable' — the deterministic
  // fallback (AI unconfigured or the loop failed / couldn't be grounded).
  mode: 'ai' | 'unavailable';
  model: string;
  prompt_version: string;
  is_draft: true;
  // Provenance for the UI / audit: which tools the loop actually called, in order.
  tool_calls: { name: string; input: unknown }[];
}

export interface AdvisorCopilotOptions {
  // Inject the tool-use transport (tests). Omit to use the resolved gateway client;
  // null resolution (AI unconfigured) takes the deterministic fallback.
  transport?: CopilotTransport;
  // Override the tool set (tests). Defaults to the curated read-only whitelist.
  tools?: CopilotTool[];
}

// Build the default transport, or null when AI is unconfigured.
function defaultTransport(): CopilotTransport | null {
  const provider = resolveProvider();
  if (!provider) return null;
  return (turn) =>
    provider.client.messages.create({
      model: provider.modelFor(turn.model),
      max_tokens: turn.max_tokens,
      system: turn.system,
      tools: turn.tools,
      messages: turn.messages,
    });
}

const textOf = (msg: Anthropic.Message): string =>
  msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

const toolUsesOf = (msg: Anthropic.Message): Anthropic.ToolUseBlock[] =>
  msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

// Answer one advisor question with a bounded tool-use loop, or degrade gracefully.
// db is the service-role client; firmId is the caller's own firm (registry scope
// 'firm', resolved upstream and trusted). userId is accepted for parity with the
// gateway handler contract (and future per-user provenance); v1 is stateless.
export async function advisorCopilot(
  db: pg.ClientBase,
  firmId: string,
  _userId: string,
  question: string,
  opts: AdvisorCopilotOptions = {},
): Promise<CopilotResult> {
  const tools = opts.tools ?? COPILOT_TOOLS;
  // Enforce the read-only whitelist against the registry before any tool can run.
  ensureReadOnlyTools(tools);
  const transport = opts.transport ?? defaultTransport();

  // AI unconfigured → deterministic fallback (the "no key" / "no credit" spirit).
  if (!transport) {
    return fallback(db, firmId, question, tools, 'AI is not configured');
  }

  try {
    return await runToolLoop(db, firmId, question, tools, transport);
  } catch (err) {
    console.warn(
      `advisor copilot ${PROMPT_VERSION}: tool-use loop failed (${aiFailureReason(err)}); ` +
        'falling back to raw tool results',
    );
    return fallback(db, firmId, question, tools, aiFailureReason(err));
  }
}

async function runToolLoop(
  db: pg.ClientBase,
  firmId: string,
  question: string,
  tools: CopilotTool[],
  transport: CopilotTransport,
): Promise<CopilotResult> {
  const system = await resolvePromptBody(db, PROMPT_VERSION);
  const definitions = toolDefinitions(tools);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
  const toolResultsText: string[] = [];
  const toolCalls: { name: string; input: unknown }[] = [];
  let answer = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const reply = await transport({ model: SYNTHESIS_MODEL, system, messages, tools: definitions, max_tokens: MAX_TOKENS });
    const uses = toolUsesOf(reply);

    if (uses.length === 0) {
      answer = textOf(reply);
      break;
    }

    // Record the assistant's tool-requesting turn, then answer each tool call.
    messages.push({ role: 'assistant', content: reply.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      const tool = byName.get(use.name);
      let data: unknown;
      if (!tool) {
        data = { error: `unknown tool '${use.name}'` };
      } else {
        try {
          data = await tool.invoke({ db, firmId }, (use.input ?? {}) as Record<string, unknown>);
        } catch (e) {
          data = { error: (e as Error).message };
        }
      }
      const str = JSON.stringify(data);
      toolResultsText.push(str);
      toolCalls.push({ name: use.name, input: use.input });
      results.push({ type: 'tool_result', tool_use_id: use.id, content: str });
    }
    messages.push({ role: 'user', content: results });
  }

  // The loop ended still wanting tools (hit the cap) with no text — force one final
  // synthesis turn WITHOUT tools so the advisor always gets an answer.
  if (!answer) {
    const forced = await transport({
      model: SYNTHESIS_MODEL,
      system,
      messages: [
        ...messages,
        { role: 'user', content: 'Answer now using only the tool results above. Do not request more tools.' },
      ],
      tools: [],
      max_tokens: MAX_TOKENS,
    });
    answer = textOf(forced);
  }

  // Numeral firewall: every figure must trace to a tool result. Regenerate once on a
  // violation (forcing synthesis, no tools), then fail — the same one-regen-then-fail
  // discipline the intelligence runtime uses. A throw here is caught by the caller
  // and degrades to the deterministic fallback.
  let violations = numeralPostCheck(answer, toolResultsText);
  if (violations.length > 0) {
    const regen = await transport({
      model: SYNTHESIS_MODEL,
      system,
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            `Your previous draft used numbers not present in the tool results (${violations.join(', ')}). ` +
            'Rewrite the answer using ONLY numbers returned by the tools; drop any figure you cannot ground.',
        },
      ],
      tools: [],
      max_tokens: MAX_TOKENS,
    });
    answer = textOf(regen);
    violations = numeralPostCheck(answer, toolResultsText);
    if (violations.length > 0) {
      throw new Error(
        `advisor copilot rejected: answer contains numbers not in any tool result: ${violations.join(', ')}`,
      );
    }
  }

  if (!answer) throw new Error('advisor copilot produced no answer text');

  return {
    question,
    answer_md: withBanner(answer),
    mode: 'ai',
    model: SYNTHESIS_MODEL,
    prompt_version: PROMPT_VERSION,
    is_draft: true,
    tool_calls: toolCalls,
  };
}

// Deterministic degradation: run the firm-scoped (no-input) read tools directly and
// render their results for the advisor to read. Honest "AI unavailable — here are the
// raw tool results", grounded entirely in real reads, so it never invents anything.
async function fallback(
  db: pg.ClientBase,
  firmId: string,
  question: string,
  tools: CopilotTool[],
  reason: string,
): Promise<CopilotResult> {
  const noInput = tools.filter((t) => !((t.input_schema.required as string[] | undefined)?.length));
  const toolCalls: { name: string; input: unknown }[] = [];
  const lines: string[] = [];
  lines.push('_AI synthesis is unavailable — here are the raw results of the firm read tools to review._');
  lines.push('');
  lines.push(`**Your question:** ${question}`);

  for (const tool of noInput) {
    let data: unknown;
    try {
      data = await tool.invoke({ db, firmId }, {});
    } catch (e) {
      data = { error: (e as Error).message };
    }
    toolCalls.push({ name: tool.name, input: {} });
    lines.push('');
    lines.push(`### ${tool.name}`);
    lines.push('```json');
    lines.push(JSON.stringify(data, null, 2));
    lines.push('```');
  }

  console.warn(`advisor copilot fallback (${reason}): returned ${noInput.length} raw tool result(s)`);

  return {
    question,
    answer_md: withBanner(lines.join('\n')),
    mode: 'unavailable',
    model: UNAVAILABLE_MODEL,
    prompt_version: PROMPT_VERSION,
    is_draft: true,
    tool_calls: toolCalls,
  };
}

// Prepend the draft banner exactly once (idempotent).
function withBanner(text: string): string {
  return text.startsWith(DRAFT_BANNER) ? text : `${DRAFT_BANNER}\n\n${text}`;
}
