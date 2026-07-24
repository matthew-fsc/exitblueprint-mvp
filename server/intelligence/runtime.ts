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
import type pg from 'pg';
import { numeralPostCheck, citationPostCheck } from './guards';
import { aiConfigured, aiFailureReason, createMessage, messageText } from '../llm/provider';
import { modelForTier, type ModelTier } from '../llm/models';
import { resolvePromptBody } from '../prompt-registry';

// Max output tokens for a drafted deliverable. Kept at a value every configured model
// supports so the request is never rejected for an over-limit max_tokens (a report or
// CIM section fits comfortably).
const MAX_OUTPUT_TOKENS = 8192;

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
  // The cost/capability tier the AI draft is generated at (server/llm/models.ts).
  // Omitted → the safe premium default, so an unspecified caller never silently
  // downgrades; existing callers now pass their agent's declared modelTier. Ignored
  // on the composer/retrieval-only fallback path (no model call happens there).
  modelTier?: ModelTier;
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

// The one way to Claude for a drafted deliverable: build the request through the
// shared createMessage (server/llm/provider.ts — plain generation, no thinking config)
// and read its text. The model is chosen by the caller's tier (server/llm/models.ts),
// defaulting to premium so a direct caller that names no tier keeps the frontier model.
// On an empty completion the error names the stop_reason and the block types so a
// "returned no text" failure is diagnosable at a glance instead of silently degrading.
export async function callClaude(
  systemPrompt: string,
  userContent: string,
  model: string = modelForTier('premium'),
): Promise<GeneratedText> {
  const response = await createMessage({
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    maxTokens: MAX_OUTPUT_TOKENS,
    // If the gateway can't serve this tier's model for the account, upgrade to premium
    // rather than dropping to the deterministic composer.
    fallbackModel: modelForTier('premium'),
  });
  const text = messageText(response);
  if (!text) {
    throw new Error(
      `narrative generation returned no text (stop_reason=${response.stop_reason}, ` +
        `blocks=[${response.content.map((b) => b.type).join(',') || 'none'}])`,
    );
  }
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
    modelTier,
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
      // Bind the caller's tier to the model call, keeping GenerateFn a 2-arg fn so
      // the firewall loop is unchanged: the tier only selects which model drafts.
      const model = modelForTier(modelTier);
      const tierGenerate: GenerateFn = (system, user) => callClaude(system, user, model);
      const generated = await firewallGenerate(
        db, promptVersion, userContent, tierGenerate, label, regenInstruction, citation,
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
