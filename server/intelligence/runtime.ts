// The intelligence runtime (docs/sellside-ai/05 §3): the ONE implementation of the
// generate → guard → pick/fallback pipeline that server/narrative.ts,
// server/diligence-simulation.ts, and server/institutional-review.ts each used to
// carry as a near-identical private copy. Those three modules now delegate here;
// only their PAYLOAD assembly and PERSISTENCE (the genuine per-artifact divergence)
// stay in the module.
//
// CLAUDE.md rules 1 & 2 live here as CODE: the numeral firewall (numeralPostCheck)
// and the citation contract (citationPostCheck) are enforced by this runtime, not
// by prompt text — the model narrates FROM a server-built payload and never
// authors a number. This module is deliberately a mid-layer: it imports the leaf
// guards, the provider, and the prompt registry, but NEVER server/narrative.ts, so
// narrative.ts can re-export GeneratedText/GenerateFn from here with no import cycle
// (narrative → runtime → guards; guards is a leaf).
import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { numeralPostCheck, citationPostCheck } from './guards';
import { aiConfigured, aiFailureReason, resolveProvider } from '../llm/provider';
import { resolvePromptBody } from '../prompt-registry';

// The AI model every reasoning agent drafts with. Namespaced to the gateway slug
// by resolveProvider().modelFor at call time.
const MODEL = 'claude-opus-4-8';

export interface GeneratedText {
  text: string;
  model: string;
}

// Injectable for tests; the default calls the Claude API (callClaude below).
export type GenerateFn = (systemPrompt: string, userContent: string) => Promise<GeneratedText>;

// Retrieved, citable passages a caller may ground on. When present on a request,
// the runtime additionally enforces the citation contract (citationPostCheck).
export interface CitationContext {
  passages: { cite_id: string; body: string }[];
}

export interface GroundedRequest {
  db: pg.ClientBase;
  // The prompt_version the AI path resolves its system prompt with (prompt-registry)
  // and the caller stamps on its persisted snapshot (rule 6).
  promptVersion: string;
  // The model label stamped when the DETERMINISTIC composer produced the draft, so
  // a reader can tell a rule-based artifact from an AI-drafted one.
  ruleBasedModel: string;
  // The EXACT user message the generator sees. Caller-supplied (not built here) so
  // each pipeline keeps its own byte-identical wording ("Assessment data (JSON):…",
  // "Diligence simulation data (JSON):…", "Assessment review data (JSON):…") and the
  // numeral firewall polices against the same embedded payload numerals it always did.
  userContent: string;
  // The deterministic fallback (lazy): the rule-based composer. Only evaluated when
  // the AI path is not taken or fails, so the happy path never pays for its queries.
  compose: () => string | Promise<string>;
  // Prepended once (idempotently) to BOTH the AI and composed output when supplied.
  draftBanner?: string;
  // When supplied, the citation contract is enforced after the numeral firewall. No
  // pipeline supplies this today, so it never affects an existing caller.
  citation?: CitationContext;
  // Explicit generator forces the strict AI path (tests). Omit it and the runtime
  // picks: Claude when configured (falling back to compose on any failure), else compose.
  generate?: GenerateFn;
  // Per-caller strings, defaulted to narrative.ts's wording, so every existing path
  // stays byte-identical while the loop is shared:
  //   label            — the module name in the hard-throw + the fallback warn.
  //   regenInstruction — the tail of the one-regeneration feedback message.
  label?: string;
  regenInstruction?: string;
}

// Prepend the draft banner exactly once. Idempotent: a composer that already leads
// with the banner is returned unchanged, so the composed path is byte-identical to
// when the composer owned the wrapping.
export function withDraftBanner(text: string, banner: string): string {
  return text.startsWith(banner) ? text : `${banner}\n\n${text}`;
}

// The one way to Claude. Body is narrative.ts's callClaude verbatim; the "not
// configured" / "no text" errors are thrown as narrative.ts threw them.
export async function callClaude(systemPrompt: string, userContent: string): Promise<GeneratedText> {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      'narrative service not configured: set AI_GATEWAY_API_KEY in the server environment',
    );
  }
  const response = await provider.client.messages.create({
    model: provider.modelFor(MODEL),
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) throw new Error(`narrative generation returned no text (${response.stop_reason})`);
  return { text, model: response.model };
}

// The strict AI path: resolve the versioned prompt, generate, enforce the numeral
// firewall (one regeneration on a violation, then a hard throw), and — only when a
// caller supplies retrieved passages — the citation contract on the same
// one-regeneration-then-throw discipline. This is the single copy of the loop that
// narrative.ts / diligence-simulation.ts / institutional-review.ts each carried.
async function firewallGenerate(
  db: pg.ClientBase,
  promptVersion: string,
  userContent: string,
  generate: GenerateFn,
  label: string,
  regenInstruction: string,
  citation: CitationContext | undefined,
): Promise<GeneratedText> {
  const systemPrompt = await resolvePromptBody(db, promptVersion);

  // Numeral firewall — byte-identical to the three former per-module loops.
  let generated = await generate(systemPrompt, userContent);
  let violations = numeralPostCheck(generated.text, userContent);
  if (violations.length > 0) {
    generated = await generate(
      systemPrompt,
      `${userContent}\n\nIMPORTANT: your previous draft used numbers not present in the data (${violations.join(', ')}). ${regenInstruction}`,
    );
    violations = numeralPostCheck(generated.text, userContent);
    if (violations.length > 0) {
      throw new Error(
        `${label} rejected: output contains numerals not present in the input payload: ${violations.join(', ')}`,
      );
    }
  }

  // Citation contract — additive, and only when passages are supplied, so the
  // numeral-only path above is untouched for every current caller (none pass it).
  if (citation) {
    let cViolations = citationPostCheck(generated.text, citation);
    if (cViolations.length > 0) {
      generated = await generate(
        systemPrompt,
        `${userContent}\n\nIMPORTANT: ${cViolations.join('; ')}. State each market figure on the same line as its bracketed [cite_id] citation.`,
      );
      // Re-hold both guards after the regeneration.
      const nViolations = numeralPostCheck(generated.text, userContent);
      if (nViolations.length > 0) {
        throw new Error(
          `${label} rejected: output contains numerals not present in the input payload: ${nViolations.join(', ')}`,
        );
      }
      cViolations = citationPostCheck(generated.text, citation);
      if (cViolations.length > 0) {
        throw new Error(`${label} rejected: ${cViolations.join('; ')}`);
      }
    }
  }

  return generated;
}

// The single pick/guard/fallback contract. Reproduces, exactly, what each pipeline
// did:
//   - explicit generator (tests) → strict AI path, a firewall violation throws;
//   - else AI configured → try callClaude, and on ANY failure warn (the "no money
//     in the account" path — aiFailureReason classifies it) and fall through;
//   - else → the deterministic composer.
// The draft banner (when supplied) is prepended once to whichever text results.
// The model is the provider's model on the AI path, or ruleBasedModel on compose.
export async function runGroundedGeneration(req: GroundedRequest): Promise<GeneratedText> {
  const {
    db,
    promptVersion,
    ruleBasedModel,
    userContent,
    compose,
    draftBanner,
    citation,
    generate,
    label = 'narrative',
    regenInstruction = 'Use only numbers from the payload.',
  } = req;

  const applyBanner = (text: string): string =>
    draftBanner === undefined ? text : withDraftBanner(text, draftBanner);

  if (generate) {
    const generated = await firewallGenerate(
      db, promptVersion, userContent, generate, label, regenInstruction, citation,
    );
    return { text: applyBanner(generated.text), model: generated.model };
  }

  if (aiConfigured()) {
    try {
      const generated = await firewallGenerate(
        db, promptVersion, userContent, callClaude, label, regenInstruction, citation,
      );
      return { text: applyBanner(generated.text), model: generated.model };
    } catch (err) {
      console.warn(
        `${label} ${promptVersion}: AI generation failed (${aiFailureReason(err)}); ` +
          'falling back to the deterministic composer',
      );
    }
  }

  return { text: applyBanner(await compose()), model: ruleBasedModel };
}
