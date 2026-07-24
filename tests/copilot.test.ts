// Advisor copilot (WS-COPILOT). Hermetic — no DB, no network. Proves the four
// things that matter:
//   1. the tool whitelist is READ-ONLY — every curated tool maps to an ungated,
//      read-open registry function, and the assertion rejects a bad tool;
//   2. the bounded tool-use loop calls a tool, then synthesizes from its result;
//   3. the numeral firewall — an answer with a number absent from the tool results
//      is regenerated once, then fails (→ fallback);
//   4. the graceful fallback — with AI unconfigured (no transport) the copilot
//      returns the raw firm-tool results, labeled 'unavailable'.
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { advisorCopilot, type CopilotTransport } from '../server/copilot';
import {
  COPILOT_TOOLS,
  assertReadOnlyTools,
  toolDefinitions,
  type CopilotTool,
} from '../server/copilot-tools';
import { REGISTRY } from '../server/registry';

// A fake db: the copilot's loop passes it to tool invokes and to resolvePromptBody.
// resolvePromptBody swallows a query rejection and falls back to the bundled
// prompts/advisor_copilot.v1.md file, so a throwing query keeps the test file-only.
const fakeDb = { query: async () => { throw new Error('no db'); } } as never;

// Build a scripted transport: each entry is one model reply (its content blocks).
// The loop consumes them in order.
function scriptedTransport(replies: Anthropic.Message['content'][]): CopilotTransport {
  let i = 0;
  return async () => {
    const content = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return { id: 'msg', model: 'fake', role: 'assistant', stop_reason: 'end_turn', content } as Anthropic.Message;
  };
}

const text = (t: string) => [{ type: 'text', text: t }] as Anthropic.Message['content'];
const toolUse = (name: string, input: unknown = {}) =>
  [{ type: 'tool_use', id: `tu_${name}`, name, input }] as Anthropic.Message['content'];

describe('copilot tool whitelist (read-only, enforced against the registry)', () => {
  it('every curated tool maps to an ungated, read-open registry function', () => {
    expect(() => assertReadOnlyTools()).not.toThrow();
    for (const tool of COPILOT_TOOLS) {
      const spec = REGISTRY[tool.registryName];
      expect(spec, `${tool.name} -> ${tool.registryName}`).toBeDefined();
      expect(spec.gated ?? false, `${tool.name} must not be gated`).toBe(false);
      expect(['firm', 'engagement'], `${tool.name} scope`).toContain(spec.scope);
    }
  });

  it('rejects a tool that maps to a gated function (a paid/billing action)', () => {
    // generate-document is gated — a copilot must never be able to invoke it.
    const bad: CopilotTool = {
      name: 'bad',
      registryName: 'generate-document',
      description: 'x',
      input_schema: { type: 'object', properties: {} },
      invoke: async () => ({}),
    };
    expect(() => assertReadOnlyTools([bad])).toThrow(/gated/i);
  });

  it('rejects a tool that maps to a write scope, and an unknown function', () => {
    const write: CopilotTool = {
      name: 'w',
      registryName: 'record-deal-outcome', // manage-engagement (staff write)
      description: 'x',
      input_schema: { type: 'object', properties: {} },
      invoke: async () => ({}),
    };
    expect(() => assertReadOnlyTools([write])).toThrow(/scope/i);
    const unknown: CopilotTool = {
      name: 'u',
      registryName: 'no-such-function',
      description: 'x',
      input_schema: { type: 'object', properties: {} },
      invoke: async () => ({}),
    };
    expect(() => assertReadOnlyTools([unknown])).toThrow(/unknown/i);
  });

  it('exposes only name/description/schema to the model (no invoke closure)', () => {
    const defs = toolDefinitions();
    expect(defs).toHaveLength(COPILOT_TOOLS.length);
    for (const d of defs) {
      expect(Object.keys(d).sort()).toEqual(['description', 'input_schema', 'name']);
    }
  });
});

describe('advisorCopilot tool-use loop', () => {
  const oneTool: CopilotTool[] = [
    {
      name: 'firm_needs_attention',
      registryName: 'firm-attention',
      description: 'the needs-attention worklist',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      invoke: async () => ({ counts: { total: 3, stalledTasks: 2 } }),
    },
  ];

  it('calls a tool, then synthesizes a grounded answer labeled draft (mode ai)', async () => {
    const transport = scriptedTransport([
      toolUse('firm_needs_attention'),
      text('You have 3 items needing attention, including 2 stalled tasks.'),
    ]);
    const res = await advisorCopilot(fakeDb, 'firm-1', 'user-1', 'What needs my attention?', {
      transport,
      tools: oneTool,
    });
    expect(res.mode).toBe('ai');
    expect(res.is_draft).toBe(true);
    expect(res.prompt_version).toBe('advisor_copilot.v1');
    expect(res.tool_calls.map((c) => c.name)).toEqual(['firm_needs_attention']);
    expect(res.answer_md).toContain('Draft');
    expect(res.answer_md).toContain('3 items');
  });

  it('numeral firewall: an ungrounded number is regenerated once, then grounded', async () => {
    // First synthesis invents "$4.2M" (not in the tool result); the regeneration
    // (forced, no tools) drops it and answers only from the grounded figures.
    const transport = scriptedTransport([
      toolUse('firm_needs_attention'),
      text('You have 3 items, and the pipeline is worth $4.2M.'),
      text('You have 3 items needing attention, including 2 stalled tasks.'),
    ]);
    const res = await advisorCopilot(fakeDb, 'firm-1', 'user-1', 'status?', {
      transport,
      tools: oneTool,
    });
    expect(res.mode).toBe('ai');
    expect(res.answer_md).not.toContain('4.2');
    expect(res.answer_md).toContain('3 items');
  });

  it('numeral firewall: a persistently ungrounded answer degrades to the fallback', async () => {
    const transport = scriptedTransport([
      toolUse('firm_needs_attention'),
      text('There are 99 items.'), // 99 is not in the tool result
      text('Actually there are 99 items.'), // regen still ungrounded
    ]);
    const res = await advisorCopilot(fakeDb, 'firm-1', 'user-1', 'status?', {
      transport,
      tools: oneTool,
    });
    // The loop failed the firewall twice → caught → deterministic fallback.
    expect(res.mode).toBe('unavailable');
    expect(res.model).toBe('unavailable:advisor_copilot.v1');
    expect(res.answer_md).toContain('AI synthesis is unavailable');
    // The fallback ran the no-input firm tool and rendered its real result.
    expect(res.answer_md).toContain('firm_needs_attention');
  });
});

describe('advisorCopilot graceful fallback (AI unconfigured)', () => {
  it('with no transport, returns the raw firm-tool results labeled unavailable', async () => {
    const invoke = vi.fn(async () => ({ counts: { total: 5 } }));
    const tools: CopilotTool[] = [
      {
        name: 'firm_needs_attention',
        registryName: 'firm-attention',
        description: 'x',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        invoke,
      },
    ];
    // transport omitted AND AI unconfigured (no gateway key) → fallback path.
    const savedKey = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      const res = await advisorCopilot(fakeDb, 'firm-1', 'user-1', 'What needs attention?', { tools });
      expect(res.mode).toBe('unavailable');
      expect(res.is_draft).toBe(true);
      expect(invoke).toHaveBeenCalledOnce();
      expect(res.answer_md).toContain('firm_needs_attention');
      expect(res.answer_md).toContain('5');
      expect(res.tool_calls.map((c) => c.name)).toEqual(['firm_needs_attention']);
    } finally {
      if (savedKey !== undefined) process.env.AI_GATEWAY_API_KEY = savedKey;
    }
  });
});
