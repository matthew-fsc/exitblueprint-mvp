// ExitBlueprint Bench — deliverable-quality eval (docs/sellside-ai/02-evaluation-bench.md).
//
// WHY this exists: the extraction eval (runner.ts) proves we read documents
// correctly; it says nothing about whether a *generated* deliverable (an owner
// report, a CIM) is advisor-quality. Following BigLaw Bench, we grade a
// deliverable on two INDEPENDENT axes:
//   - answer score  — how much of a required, advisor-quality work product is
//                     present, with hallucinations counted AGAINST it (a human
//                     has to undo them);
//   - source score  — of the points that must be traceable, how many actually
//                     trace back to the payload.
// A report can be complete but untraceable, so the two are reported and
// thresholded separately (ci.ts).
//
// This module is the SAFE, CI-gating tier: every check is a pure function over
// (markdown, payload, rubric). No database, no API key, no LLM call is on the
// CI path — that is a hard requirement (CLAUDE.md rule 1/2 keep AI out of
// scoring, and CI must run without secrets). The LLM-as-judge tier is only
// TYPED here (see LLMJudge / NO_OP_JUDGE); it is the scaling tier and is gated
// off in CI.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// The numeral firewall from the narrative service IS the "no hallucinated
// number" negative criterion — reuse it verbatim so the bench polices exactly
// what the shipping path polices, and the two never drift.
import { numeralPostCheck } from '../../narrative';

// --- Check descriptors ---------------------------------------------------------
// A criterion names a small, pure check by its `type`. The registry
// (CHECKS below) maps each type to a helper. Keep this union small and
// extensible: a new deterministic check is one union member plus one helper.

/** Any numeral in the output that is not present in the payload is a
 *  hallucination. Reuses numeralPostCheck. Used as a NEGATIVE criterion. */
export interface NoHallucinatedNumberCheck {
  type: 'no_hallucinated_number';
}

/** At least one of `patterns` (regex sources, case-insensitive) must be ABSENT
 *  from the output. "Fired" means a forbidden pattern was found — e.g. a `$`,
 *  a valuation, or a multiple in an owner report. Used as a NEGATIVE criterion. */
export interface MustNotContainCheck {
  type: 'must_not_contain';
  patterns: string[];
}

/** At least one of `phrases` (literal, case-insensitive substrings) must be
 *  present. "Fired" means present. Used as a POSITIVE criterion. */
export interface MustContainAnyCheck {
  type: 'must_contain_any';
  phrases: string[];
}

/** The value the payload holds at `path` (dotted, array-index aware, e.g.
 *  "top_gaps.0.name") must appear verbatim in the output. "Fired" means
 *  present. This is answer completeness when axis is 'answer', and a
 *  traceability check (the named thing traces back to a payload entry) when
 *  axis is 'source'. Used as a POSITIVE criterion on either axis. */
export interface PayloadFieldPresentCheck {
  type: 'payload_field_present_in_output';
  path: string;
}

export type BenchCheck =
  | NoHallucinatedNumberCheck
  | MustNotContainCheck
  | MustContainAnyCheck
  | PayloadFieldPresentCheck;

// --- Rubric types --------------------------------------------------------------

export interface BenchCriterion {
  id: string;
  weight: number;
  kind: 'positive' | 'negative';
  axis: 'answer' | 'source';
  /** Human-readable statement of what the criterion asserts (for failures). */
  description: string;
  check: BenchCheck;
}

/** The rubric for one doc_type: methodology in data, not code (rule 3 spirit).
 *  Answer and source criteria are separate lists because they feed the two
 *  independent axes. A criterion's `axis` field mirrors the list it lives in. */
export interface BenchRubric {
  docType: string;
  answer: BenchCriterion[];
  source: BenchCriterion[];
}

export interface BenchCase {
  name: string;
  /** A generated deliverable, as markdown on disk. */
  deliverablePath: string;
  /** The structured payload the deliverable was written FROM. */
  payloadPath: string;
  /** The rubric (data) for this deliverable's doc_type. */
  rubricPath: string;
}

export interface BenchScore {
  name: string;
  /** Clamped to [0,1] for reporting/thresholding. */
  answerScore: number;
  /** Unclamped raw answer score — can exceed 0..1 (hallucinations can push it
   *  negative). Kept alongside the clamped value so a deeply-wrong deliverable
   *  is distinguishable from a merely-incomplete one when debugging. */
  answerScoreRaw: number;
  sourceScore: number;
  failures: string[];
}

// --- Deterministic check registry ---------------------------------------------
// Each helper returns whether the check's CONDITION FIRED, independent of sign.
// The scorer decides what firing means: for a positive criterion, fired = the
// required content is present (earned); for a negative criterion, fired = the
// forbidden condition is present (incurred). Keeping the sign out of the
// helpers is what lets one check type (payload_field_present_in_output) serve
// both a positive answer criterion and a source-traceability criterion.

function resolvePath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const key of path.split('.')) {
    if (cur == null) return undefined;
    // Array indices arrive as numeric path segments.
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const CHECKS: {
  [K in BenchCheck['type']]: (
    markdown: string,
    payload: unknown,
    check: Extract<BenchCheck, { type: K }>,
  ) => boolean;
} = {
  no_hallucinated_number: (markdown, payload) => numeralPostCheck(markdown, payload).length > 0,

  must_not_contain: (markdown, _payload, check) =>
    check.patterns.some((p) => new RegExp(p, 'i').test(markdown)),

  must_contain_any: (markdown, _payload, check) => {
    const haystack = markdown.toLowerCase();
    return check.phrases.some((phrase) => haystack.includes(phrase.toLowerCase()));
  },

  payload_field_present_in_output: (markdown, payload, check) => {
    const value = resolvePath(payload, check.path);
    if (value == null) return false;
    return markdown.toLowerCase().includes(String(value).toLowerCase());
  },
};

/** Dispatch a criterion's check to its helper. Exported for tests. */
export function runCheck(check: BenchCheck, markdown: string, payload: unknown): boolean {
  // The registry is keyed by check.type; the double cast reunites the value
  // (a union of narrowed helpers) with the widened signature so each helper
  // still sees its own descriptor shape at authoring time.
  const fn = CHECKS[check.type] as unknown as (m: string, p: unknown, c: BenchCheck) => boolean;
  return fn(markdown, payload, check);
}

// --- The grader ----------------------------------------------------------------

/**
 * Pure grader. Implements the doc's formulas:
 *   answerScore = (Σ earned positive weights − Σ incurred negative weights)
 *                 ÷ (Σ available positive weights), clamped to [0,1] for
 *                 reporting (raw kept on answerScoreRaw).
 *   sourceScore = (# citation-required points satisfied) ÷ (# required), and
 *                 = 1 when there are none.
 */
export function gradeDeliverable(
  markdown: string,
  payload: unknown,
  rubric: BenchRubric,
): BenchScore {
  const failures: string[] = [];

  let earnedPositive = 0;
  let incurredNegative = 0;
  let availablePositive = 0;

  for (const c of rubric.answer) {
    const fired = runCheck(c.check, markdown, payload);
    if (c.kind === 'positive') {
      availablePositive += c.weight;
      if (fired) earnedPositive += c.weight;
      else failures.push(`answer: ${c.id} not satisfied — ${c.description}`);
    } else {
      // negative: firing means the forbidden condition is present
      if (fired) {
        incurredNegative += c.weight;
        failures.push(`answer: ${c.id} violated — ${c.description}`);
      }
    }
  }

  // Guard the division: a rubric with no positive answer weight scores 1 when
  // clean, 0 when any hallucination/forbidden condition fired.
  const answerScoreRaw =
    availablePositive === 0
      ? incurredNegative === 0
        ? 1
        : 0
      : (earnedPositive - incurredNegative) / availablePositive;
  const answerScore = Math.max(0, Math.min(1, answerScoreRaw));

  let satisfiedSource = 0;
  for (const c of rubric.source) {
    const fired = runCheck(c.check, markdown, payload);
    // A source criterion is satisfied when its (positive) traceability check
    // fires; a negative source criterion is satisfied when its bad condition
    // does NOT fire. Both axes reduce to: satisfied = positive ? fired : !fired.
    const satisfied = c.kind === 'positive' ? fired : !fired;
    if (satisfied) satisfiedSource += 1;
    else failures.push(`source: ${c.id} untraceable — ${c.description}`);
  }
  const sourceScore = rubric.source.length === 0 ? 1 : satisfiedSource / rubric.source.length;

  return { name: rubric.docType, answerScore, answerScoreRaw, sourceScore, failures };
}

// --- Case runner (reads the three files, then grades) --------------------------

/** Read a bench case's deliverable/payload/rubric from disk and grade it.
 *  Synchronous and pure over files — no DB, no network, no API key. */
export function scoreBenchCase(c: BenchCase): BenchScore {
  const markdown = readFileSync(c.deliverablePath, 'utf8');
  const payload = JSON.parse(readFileSync(c.payloadPath, 'utf8')) as unknown;
  const rubric = JSON.parse(readFileSync(c.rubricPath, 'utf8')) as BenchRubric;
  const score = gradeDeliverable(markdown, payload, rubric);
  // Carry the case's own name for reporting (the rubric supplies docType).
  return { ...score, name: c.name };
}

// --- LLM-as-judge tier (TYPED ONLY — not run in CI) ----------------------------
// The scaling tier for subjective criteria ("explains why a buyer cares in
// plain language") that no regex can grade. It is a SEPARATE concern from
// generation, versioned behind its own prompt_version, and anchored to
// Matthew's hand-graded golden set. It is deliberately NOT implemented or
// called here: the CI path stays deterministic and secret-free. When it lands,
// it runs on a labeled [eval] job, never on the free CI gate.

export interface LLMJudge {
  judge(markdown: string, criterion: BenchCriterion): Promise<{ pass: boolean; rationale: string }>;
}

/** Default judge: a no-op that passes everything, so the type composes without
 *  ever making an API call. Replaced by a real, versioned judge in the [eval]
 *  tier — never on the CI path. */
export const NO_OP_JUDGE: LLMJudge = {
  async judge() {
    return { pass: true, rationale: 'llm-judge tier disabled in CI (deterministic checks only)' };
  },
};

// --- Registered bench cases ----------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const rubricsDir = join(here, 'rubrics');

// Add a case = drop a (deliverable.md, payload.json) pair + a rubric.json here.
export const BENCH_CASES: BenchCase[] = [
  {
    name: 'owner_report.baseline',
    deliverablePath: join(fixturesDir, 'owner_report.baseline.deliverable.md'),
    payloadPath: join(fixturesDir, 'owner_report.baseline.payload.json'),
    rubricPath: join(rubricsDir, 'owner_report.baseline.json'),
  },
];

/** Grade every registered bench case. Async to match the harness (runner.ts's
 *  runAll) and to leave room for the future [eval] judge tier, though the CI
 *  path itself is fully synchronous and pure. */
export async function runBench(): Promise<BenchScore[]> {
  return BENCH_CASES.map(scoreBenchCase);
}
