// ExitBlueprint Bench — the LLM-as-judge tier (docs/sellside-ai/02-evaluation-bench.md).
//
// WHY this is separate from bench.ts: the deterministic bench (bench.ts) grades
// everything a regex can — required facts present, numeral firewall, citation
// contract — and gates CI for free, with no secret and no API call. But some
// quality criteria are irreducibly subjective ("explains why a buyer cares in
// plain language"). Those are graded HERE, by a versioned Claude call, and ONLY
// on a labeled [eval] job. This file is the ONLY place in the eval stack that can
// touch a provider, and it is guarded so that touch can never happen on the free
// CI path (judgeEnabled()).
//
// RULE ALIGNMENT: the judge never computes or adjusts a DRS/ORI score (rule 1) —
// it classifies PROSE quality, advisory to CI. It is versioned behind its own
// prompt_version (bench_judge.v1, rule 6) and anchored to a hand-graded golden set
// (fixtures/judge_golden.json): if the judge disagrees with a human anchor, the
// judge PROMPT is the bug, not the anchor. The judge is CLASSIFICATION-shaped, so
// it runs on the economy (free) tier (modelForTier('economy')) — cost discipline.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelForTier } from '../models';
import { anthropicTransport, type LlmTransport } from '../client';
import { aiConfigured } from '../provider';
import type { BenchCriterion, BenchRubric, JudgeVerdict, LLMJudge } from './bench';
import { subjectiveCriteria } from './bench';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(here, '..', '..', '..', 'prompts', 'bench_judge.v1.md');
const GOLDEN_PATH = join(here, 'fixtures', 'judge_golden.json');

/** The judge's prompt_version — logged/persisted for attribution (rule 6). */
export const JUDGE_PROMPT_VERSION = 'bench_judge.v1';

// The judge system prompt lives in a file (methodology as data, not inline at the
// call site), read once at module load.
const JUDGE_SYSTEM = readFileSync(PROMPT_PATH, 'utf8');

/**
 * The judge tier runs ONLY when BOTH are true:
 *   1. AI_GATEWAY_API_KEY is present (aiConfigured) — there is a provider to call;
 *   2. RUN_LLM_JUDGE is explicitly set truthy — an operator opted this run in.
 * Either missing ⇒ the tier skips cleanly, exactly like the DB-backed generated
 * tier skips without DATABASE_URL. This is the hard guarantee that the free CI
 * path (`npm run eval` with no key) never makes an API call.
 */
export function judgeEnabled(): boolean {
  const flag = process.env.RUN_LLM_JUDGE;
  const flagOn = Boolean(flag && /^(1|true|yes|on)$/i.test(flag.trim()));
  return flagOn && aiConfigured();
}

/** Parse the model's two-line verdict. Conservative: anything that does not
 *  clearly say PASS is treated as FAIL, so a malformed judge response can never
 *  silently pass a subjective criterion. */
export function parseVerdict(text: string): JudgeVerdict {
  const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL)/i);
  const rationaleMatch = text.match(/RATIONALE:\s*(.+)/i);
  const rationale = (rationaleMatch?.[1] ?? text.trim().split('\n')[0] ?? '').trim().slice(0, 240);
  if (!verdictMatch) {
    return { pass: false, rationale: `unparseable judge verdict — treated as FAIL: ${rationale}` };
  }
  return { pass: verdictMatch[1].toUpperCase() === 'PASS', rationale };
}

export interface JudgeOptions {
  /** Injectable transport so tests are hermetic (a fake supplies canned verdicts);
   *  the default is the real Anthropic gateway transport. */
  transport?: LlmTransport;
  /** Override the judge model id; defaults to the economy (free) tier. */
  model?: string;
  maxTokens?: number;
}

/**
 * Build the versioned judge. Classification-shaped, so it routes to the economy
 * tier by default. The returned object satisfies the LLMJudge interface declared
 * in bench.ts; bench.ts itself never imports this file, so its deterministic
 * grader stays provider-free.
 */
export function createLLMJudge(opts: JudgeOptions = {}): LLMJudge {
  const transport = opts.transport ?? anthropicTransport;
  const model = opts.model ?? modelForTier('economy');
  const maxTokens = opts.maxTokens ?? 256;

  return {
    promptVersion: JUDGE_PROMPT_VERSION,
    async judge(markdown: string, criterion: BenchCriterion): Promise<JudgeVerdict> {
      if (criterion.check.type !== 'llm_judge') {
        // Defensive: the deterministic grader owns everything else. Never send a
        // regex-checkable criterion to a paid/free model.
        throw new Error(`judge: criterion '${criterion.id}' is not an llm_judge criterion`);
      }
      const user =
        `CRITERION: ${criterion.check.question}\n\n` +
        `DELIVERABLE:\n"""\n${markdown}\n"""\n\n` +
        'Grade the deliverable against the criterion and respond in the required two-line format.';
      const res = await transport({ model, system: JUDGE_SYSTEM, user, maxTokens });
      return parseVerdict(res.text);
    },
  };
}

// --- Golden anchor calibration -------------------------------------------------
// The domain expert stays the ground truth: each anchor pins one subjective
// criterion to a hand-labeled verdict. Running the judge over the anchors and
// checking agreement is how we detect a judge-prompt regression BEFORE trusting
// the judge on live deliverables.

export interface JudgeAnchor {
  id: string;
  criterionId: string;
  question: string;
  markdown: string;
  expected: boolean;
}

export function loadJudgeGolden(): JudgeAnchor[] {
  const raw = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as { anchors: JudgeAnchor[] };
  return raw.anchors;
}

export interface AnchorResult {
  id: string;
  expected: boolean;
  got: boolean;
  agrees: boolean;
  rationale: string;
}

export interface CalibrationResult {
  total: number;
  agreements: number;
  agreementRate: number; // agreements / total, 1 when there are no anchors
  results: AnchorResult[];
}

/** Run the judge over every anchor and report agreement with the human labels.
 *  A synthetic criterion is built per anchor so the judge sees the same shape it
 *  sees for a real rubric criterion. */
export async function runJudgeCalibration(
  judge: LLMJudge,
  anchors: JudgeAnchor[] = loadJudgeGolden(),
): Promise<CalibrationResult> {
  const results: AnchorResult[] = [];
  for (const a of anchors) {
    const criterion: BenchCriterion = {
      id: a.criterionId,
      weight: 1,
      kind: 'positive',
      axis: 'answer',
      description: a.question,
      check: { type: 'llm_judge', question: a.question },
    };
    const verdict = await judge.judge(a.markdown, criterion);
    results.push({
      id: a.id,
      expected: a.expected,
      got: verdict.pass,
      agrees: verdict.pass === a.expected,
      rationale: verdict.rationale,
    });
  }
  const agreements = results.filter((r) => r.agrees).length;
  return {
    total: results.length,
    agreements,
    agreementRate: results.length === 0 ? 1 : agreements / results.length,
    results,
  };
}

// --- Judging a real deliverable's subjective criteria --------------------------

export interface JudgedCriterion {
  id: string;
  axis: 'answer' | 'source';
  pass: boolean;
  rationale: string;
}

export interface JudgeAxisScore {
  /** Fraction of subjective criteria the judge passed, in [0,1]; 1 when a rubric
   *  has none. This is the third, judge axis surfaced alongside answer + source. */
  judgeScore: number;
  total: number;
  passed: number;
  criteria: JudgedCriterion[];
}

/** Grade a deliverable's SUBJECTIVE criteria only (the deterministic axes are
 *  bench.ts's job). Returns the judge axis: fraction of subjective criteria the
 *  judge passed. */
export async function judgeDeliverable(
  judge: LLMJudge,
  markdown: string,
  rubric: BenchRubric,
): Promise<JudgeAxisScore> {
  const criteria = subjectiveCriteria(rubric);
  const graded: JudgedCriterion[] = [];
  for (const c of criteria) {
    const verdict = await judge.judge(markdown, c);
    graded.push({ id: c.id, axis: c.axis, pass: verdict.pass, rationale: verdict.rationale });
  }
  const passed = graded.filter((g) => g.pass).length;
  return {
    judgeScore: graded.length === 0 ? 1 : passed / graded.length,
    total: graded.length,
    passed,
    criteria: graded,
  };
}
