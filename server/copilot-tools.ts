// The advisor copilot's CURATED, READ-ONLY tool surface (WS-COPILOT). The copilot
// (server/copilot.ts) runs an Anthropic tool-use loop; these are the only tools it
// may call. Every tool maps to an EXISTING registry read handler and is anchored to
// that registry entry by name (`registryName`), so the read-only guarantee is
// ENFORCED against the registry, not asserted by convention:
//
//   * the mapped registry entry must exist,
//   * it must NOT be `gated` (a copilot must never invoke a paid/billing action),
//   * its auth scope must be read-open (`firm` or `engagement`) — never a staff
//     write scope (manage-engagement / admin / document-* / *-item / platform-admin).
//
// assertReadOnlyTools() checks all three at module load, so adding a tool that maps
// to a write/gated/out-of-scope function fails fast (and is covered by a unit test).
//
// The copilot itself is firm-scoped (registry scope 'firm'): firmId is resolved from
// the caller's profile upstream and trusted here. The service-role client bypasses
// RLS, so an engagement-scoped tool re-checks that the engagement belongs to the
// caller's firm before reading — defense in depth against a model passing an id from
// outside the firm (rule #5, firm isolation).
//
// Deliberately EXCLUDED: valuation. The only valuation endpoint (`compute-valuation`)
// is `gated`, so it is off-limits by the whitelist rule above; the copilot reads
// calibration, attention, and the engagement graph instead.
import type pg from 'pg';
import type Anthropic from '@anthropic-ai/sdk';
import { REGISTRY } from './registry';
import { engagementGraph } from './engagement-graph';
import { firmAttention } from './attention';
import { firmCalibration } from './outcomes';
import { listDiligenceQa } from './diligence-qa';

// The auth scopes a copilot tool may map to. `firm` reads the caller's own firm
// (firmId trusted); `engagement` reads one engagement (re-checked to belong to the
// firm here). Any other scope names a staff write or cross-tenant action — excluded.
const READ_ONLY_SCOPES = new Set(['firm', 'engagement']);

export interface CopilotToolContext {
  db: pg.ClientBase;
  firmId: string;
}

export interface CopilotTool {
  // The name the model calls (snake_case, tool-use convention).
  name: string;
  // Human-readable title for the fallback surface (the deterministic degradation
  // renders these reads for the advisor). Optional — falls back to `name`.
  label?: string;
  // The REGISTRY read handler this tool is derived from — the whitelist anchor.
  registryName: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  // Run the underlying read. Returns plain JSON-serializable data; the loop
  // stringifies it into the tool_result and grounds the numeral firewall on it.
  invoke: (ctx: CopilotToolContext, input: Record<string, unknown>) => Promise<unknown>;
}

// A firm-scoped tool takes no input — the firm is resolved upstream.
const NO_INPUT: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// Confirm an engagement belongs to the caller's firm before an engagement-scoped
// read touches it. The service client bypasses RLS, so this is the tenancy gate.
async function engagementInFirm(db: pg.ClientBase, engagementId: string, firmId: string): Promise<boolean> {
  const r = await db.query(`select id from engagements where id = $1 and firm_id = $2`, [
    engagementId,
    firmId,
  ]);
  return r.rowCount === 1;
}

export const COPILOT_TOOLS: CopilotTool[] = [
  {
    name: 'firm_needs_attention',
    label: 'Needs attention',
    registryName: 'firm-attention',
    description:
      "The firm's in-app 'needs attention' worklist: engagements whose reassessment " +
      'is ready or due, stalled roadmap tasks, and stale engagements — each with the ' +
      'engagement id and company name. Call this to answer "what needs my attention", ' +
      '"what is overdue", or to find engagement ids to inspect further.',
    input_schema: NO_INPUT,
    invoke: ({ db, firmId }) => firmAttention(db, firmId),
  },
  {
    name: 'firm_deal_calibration',
    label: 'Deal calibration',
    registryName: 'deal-calibration',
    description:
      "Predicted-vs-actual across the firm's recorded deal outcomes: how many deals " +
      'closed / broke / were withdrawn, average EV variance, within-range rate, average ' +
      'final multiple, days on market, retrade rate, and a per-deal list with company ' +
      'name, predicted vs final EV, and final multiple. Call this for questions about ' +
      "the firm's track record, close rates, or how accurate the platform's predictions have been.",
    input_schema: NO_INPUT,
    invoke: ({ db, firmId }) => firmCalibration(db, firmId),
  },
  {
    name: 'firm_engagement_graph',
    label: 'Gap remediation effectiveness',
    registryName: 'engagement-graph',
    description:
      'Cross-engagement gap-remediation effectiveness for the firm: for each gap that ' +
      'was cleared, the average DRS movement and average dimension movement it produced, ' +
      'how many clears drove the average, and the average final multiple where the deal ' +
      'later closed. Call this to answer "which fixes move the score most" or "what has ' +
      "clearing a given gap been worth across our book.",
    input_schema: NO_INPUT,
    invoke: ({ db, firmId }) => engagementGraph(db, firmId),
  },
  {
    name: 'engagement_diligence_qa',
    label: 'Diligence Q&A history',
    registryName: 'list-diligence-qa',
    description:
      "The persisted buyer-diligence Q&A history for ONE engagement (newest first): each " +
      'question, its drafted answer, whether it was AI-synthesized or retrieval-only, and ' +
      'the cited sources. Requires an engagement_id — get one from firm_needs_attention or ' +
      'firm_deal_calibration first. Use this to see what diligence questions have already ' +
      'been rehearsed for a specific client.',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: {
          type: 'string',
          description: 'The engagement id, as returned by another tool for this firm.',
        },
      },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    invoke: async ({ db, firmId }, input) => {
      const engagementId = typeof input.engagement_id === 'string' ? input.engagement_id : '';
      if (!engagementId) return { error: 'engagement_id is required' };
      if (!(await engagementInFirm(db, engagementId, firmId))) {
        return { error: 'engagement not found in this firm' };
      }
      return { items: await listDiligenceQa(db, engagementId) };
    },
  },
];

// Enforce the read-only guarantee against the REGISTRY (not by convention). Throws
// if any tool maps to a missing, gated, or non-read-open registry entry. Exercised
// by a unit test and run once at the copilot's first call (ensureReadOnlyTools) —
// NOT at module load: registry.ts → copilot.ts → copilot-tools.ts → registry.ts is a
// cycle, so REGISTRY is still uninitialized during this module's load. Deferring the
// check to call time reads a fully-built REGISTRY.
export function assertReadOnlyTools(tools: CopilotTool[] = COPILOT_TOOLS): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`copilot tool '${tool.name}' is declared twice`);
    seen.add(tool.name);
    const spec = REGISTRY[tool.registryName];
    if (!spec) {
      throw new Error(`copilot tool '${tool.name}' maps to unknown registry function '${tool.registryName}'`);
    }
    if (spec.gated) {
      throw new Error(
        `copilot tool '${tool.name}' maps to GATED function '${tool.registryName}' — the copilot must never invoke a paid/billing action`,
      );
    }
    if (!READ_ONLY_SCOPES.has(spec.scope)) {
      throw new Error(
        `copilot tool '${tool.name}' maps to '${tool.registryName}' with non-read scope '${spec.scope}' — copilot tools must be firm/engagement reads`,
      );
    }
  }
}

// Run the whitelist check once, on the first copilot call (see the cycle note on
// assertReadOnlyTools). Memoized so it costs nothing after the first invocation.
let validated = false;
export function ensureReadOnlyTools(tools: CopilotTool[] = COPILOT_TOOLS): void {
  if (validated) return;
  assertReadOnlyTools(tools);
  validated = true;
}

// The tool definitions the model sees (name, description, schema) — the invoke
// closures are stripped, since the model only needs the calling contract.
export function toolDefinitions(tools: CopilotTool[] = COPILOT_TOOLS): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
