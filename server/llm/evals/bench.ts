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
import type pg from 'pg';
import {
  numeralPostCheck,
  buildOwnerReportPayload,
  buildDeltaReportPayload,
  generateDocument,
} from '../../narrative';
import { buildCimPayload } from '../../cim';
import { explainAssessment } from '../../scoring';
// The citation contract from the intelligence runtime IS the source-axis check
// for a Q&A/deliverable that answers FROM retrieved passages: every figure a
// passage carries must be stated adjacent to that passage's [cite_id]. Reuse it
// verbatim so the bench polices exactly what the shipping runtime polices.
import { citationPostCheck } from '../../intelligence/guards';

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

/** Every retrieved passage under `factsPath` (default "facts") that carries a
 *  numeral in its `body` must have that passage's `cite_id` on the SAME output
 *  line as the numeral — the citation contract (server/intelligence/guards.ts
 *  citationPostCheck), reused verbatim. "Fired" means at least one figure is
 *  stated without its source citation. Used as a NEGATIVE source criterion
 *  (satisfied = did NOT fire), so an untraceable stated fact fails the axis. */
export interface FactsCarryCitationCheck {
  type: 'facts_carry_citation';
  factsPath?: string;
}

/** Every MARKET figure stated in the output must be cited: a numeral drawn from a
 *  retrieved market passage must appear on the same line as that passage's
 *  [cite_id]. Runs the citation contract (server/intelligence/guards.ts
 *  citationPostCheck) over the payload's `market_context` passages. "Fired" means
 *  an uncited market figure was found. Used as a NEGATIVE source criterion
 *  (traceability). No `market_context` in the payload → nothing to police → does
 *  not fire (graceful — a deliverable with no market grounding is not penalized). */
export interface UncitedMarketFigureCheck {
  type: 'uncited_market_figure';
}

export type BenchCheck =
  | NoHallucinatedNumberCheck
  | MustNotContainCheck
  | MustContainAnyCheck
  | PayloadFieldPresentCheck
  | FactsCarryCitationCheck
  | UncitedMarketFigureCheck;

/** A SUBJECTIVE criterion no regex can grade ("explains why a buyer cares in
 *  plain language"). It is NOT a deterministic BenchCheck: the pure CI grader
 *  SKIPS it, and the separate, secret-gated LLM-judge tier (server/llm/evals/
 *  judge.ts) grades it against the human golden set. `question` is the yes/no
 *  the judge answers. Kept OUT of BenchCheck so the deterministic CHECKS
 *  registry never has to (and never can) dispatch an LLM call. */
export interface LlmJudgeCheck {
  type: 'llm_judge';
  question: string;
}

/** The full set a rubric criterion may carry: a deterministic check OR the
 *  judge-only subjective check. The deterministic grader handles the former and
 *  skips the latter. */
export type BenchCriterionCheck = BenchCheck | LlmJudgeCheck;

// --- Rubric types --------------------------------------------------------------

export interface BenchCriterion {
  id: string;
  weight: number;
  kind: 'positive' | 'negative';
  axis: 'answer' | 'source';
  /** Human-readable statement of what the criterion asserts (for failures). */
  description: string;
  check: BenchCriterionCheck;
}

/** True when a criterion is graded by the LLM-judge tier, not the deterministic
 *  grader. The CI path uses this to SKIP subjective criteria so it stays pure. */
export function isJudgeCriterion(c: BenchCriterion): boolean {
  return c.check.type === 'llm_judge';
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

  facts_carry_citation: (markdown, payload, check) => {
    const facts = resolvePath(payload, check.factsPath ?? 'facts');
    if (!Array.isArray(facts)) return false; // no facts ⇒ nothing to cite ⇒ never fires
    const passages = facts
      .filter(
        (f): f is { cite_id: string; body: string } =>
          f != null &&
          typeof (f as Record<string, unknown>).cite_id === 'string' &&
          typeof (f as Record<string, unknown>).body === 'string',
      )
      .map((f) => ({ cite_id: String(f.cite_id), body: String(f.body) }));
    // Fired = at least one stated figure lacks its passage's [cite_id] on the line.
    return citationPostCheck(markdown, { passages }).length > 0;
  },

  uncited_market_figure: (markdown, payload) => {
    // The payload's market_context (server/cim.ts CimPayload) holds the retrieved,
    // cited passages; citationPostCheck flags any market figure stated without its
    // [cite_id] on the same line. No market_context → no passages → no violations.
    const passages =
      (payload as { market_context?: { cite_id: string; body: string }[] }).market_context ?? [];
    return citationPostCheck(markdown, { passages }).length > 0;
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
    // Subjective (llm_judge) criteria are NOT deterministic — they belong to the
    // secret-gated judge tier (judge.ts). The pure CI grader skips them so it
    // never needs an API key; the judge tier grades them separately.
    if (c.check.type === 'llm_judge') continue;
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
    if (c.check.type === 'llm_judge') continue; // judge-only, graded off the CI path
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

// --- LLM-as-judge tier (INTERFACE here; IMPLEMENTATION in judge.ts) -------------
// The scaling tier for subjective criteria ("explains why a buyer cares in
// plain language") that no regex can grade. It is a SEPARATE concern from
// generation, versioned behind its own prompt_version (bench_judge.v1), and
// anchored to a hand-graded golden set. Only the INTERFACE lives here so bench.ts
// stays free of any provider/secret import and the CI path stays deterministic.
// The real, versioned judge is server/llm/evals/judge.ts (createLLMJudge); it is
// invoked ONLY on a labeled [eval] job guarded on AI_GATEWAY_API_KEY + RUN_LLM_JUDGE,
// never on the free CI gate.

export interface JudgeVerdict {
  pass: boolean;
  rationale: string;
}

export interface LLMJudge {
  /** prompt_version of the judge, for attribution (rule 6). */
  readonly promptVersion: string;
  judge(markdown: string, criterion: BenchCriterion): Promise<JudgeVerdict>;
}

/** The subjective (judge-only) criteria across a rubric's answer + source lists,
 *  in order. The judge tier grades exactly these; the deterministic grader skips
 *  them. Empty for a rubric with no subjective criteria. */
export function subjectiveCriteria(rubric: BenchRubric): BenchCriterion[] {
  return [...rubric.answer, ...rubric.source].filter(isJudgeCriterion);
}

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
  {
    // Diligence Q&A: answer = used the required retrieved facts; source = every
    // stated fact carries its [cite_id] (facts_carry_citation reuses the runtime's
    // citation contract). Its subjective "explains why a buyer cares" criterion is
    // judge-only and skipped by this deterministic tier.
    name: 'diligence_qa.baseline',
    deliverablePath: join(fixturesDir, 'diligence_qa.baseline.deliverable.md'),
    payloadPath: join(fixturesDir, 'diligence_qa.baseline.payload.json'),
    rubricPath: join(rubricsDir, 'diligence_qa.baseline.json'),
  },
];

/** Grade every registered bench case. Async to match the harness (runner.ts's
 *  runAll) and to leave room for the future [eval] judge tier, though the CI
 *  path itself is fully synchronous and pure. */
export async function runBench(): Promise<BenchScore[]> {
  return BENCH_CASES.map(scoreBenchCase);
}

// --- DB-backed generated tier (grades the REAL code path) ----------------------
// The static tier above grades a frozen fixture markdown. This tier grades the
// deliverable the SHIPPING code actually produces: it builds the payload and
// runs the real generateDocument with NO GenerateFn, so generateDocument/compose*
// take the deterministic composer branch (rule-based, no API key, no LLM call —
// see server/narrative.ts pickNarrative). The produced markdown is then graded
// by the EXACT same pure gradeDeliverable + check registry the static tier uses.
// This tier needs a live DB (it reads a completed assessment) and is therefore
// GUARDED off the free CI path — ci.ts only runs it when a DATABASE_URL and a
// completed assessment are present, and skips cleanly otherwise.

/** Maps a doc_type to the same build*Payload the composer writes FROM, so the
 *  grade runs against the identical structured payload the deliverable was built
 *  from. Deterministic: buildPayload over the same DB/assessment yields the same
 *  payload the composer saw, so grading is stable. */
const PAYLOAD_BUILDERS: Record<
  string,
  (db: pg.ClientBase, assessmentId: string) => Promise<unknown>
> = {
  owner_report: buildOwnerReportPayload,
  delta_report: buildDeltaReportPayload,
  cim: buildCimPayload,
  teaser: buildCimPayload,
  management_presentation: buildCimPayload,
};

/**
 * Generate a deliverable through the REAL code path (deterministic composer) and
 * grade the produced markdown with the existing pure gradeDeliverable.
 *   1. build the payload the deliverable is written FROM (build*Payload);
 *   2. call generateDocument with NO generator → the rule-based composer branch,
 *      which persists a generated_documents row and returns it;
 *   3. grade the returned content_md against the rubric on disk.
 * No API key is ever required. Reuses gradeDeliverable and the check registry
 * unchanged.
 */
export async function scoreGeneratedDeliverable(
  db: pg.ClientBase,
  opts: { assessmentId: string; docType: string; rubricPath: string },
): Promise<BenchScore> {
  const build = PAYLOAD_BUILDERS[opts.docType];
  if (!build) throw new Error(`bench: no payload builder registered for doc_type '${opts.docType}'`);

  // The payload the composer wrote FROM — grading is against this exact shape.
  const payload = await build(db, opts.assessmentId);

  // The REAL deliverable: no GenerateFn ⇒ deterministic composer, no API key.
  const doc = await generateDocument(db, opts.assessmentId, opts.docType);
  const markdown = String(doc.content_md);

  const rubric = JSON.parse(readFileSync(opts.rubricPath, 'utf8')) as BenchRubric;

  // Numeral-whitelist source. The AI path's firewall whitelists only the doc's
  // payload, but the DETERMINISTIC composer (the path graded here, no API key)
  // legitimately phrases the FULL engine trace — dimension and sub-score
  // numbers that are engine output, not payload fields. So for the generated
  // tier we widen the whitelist to payload + explain trace: the criterion still
  // catches a genuinely stray/invented number, but no longer false-flags a real
  // deterministic-engine figure. Rubric field-path checks are unaffected — the
  // payload's own fields stay at the top level; the trace is added under a
  // reserved key that no rubric path references.
  const explain = await explainAssessment(db, opts.assessmentId);
  const gradeInput = { ...(payload as Record<string, unknown>), _engine_trace: explain };
  const score = gradeDeliverable(markdown, gradeInput, rubric);
  return { ...score, name: `${opts.docType}.generated` };
}

export interface GeneratedBenchCase {
  name: string;
  docType: string;
  rubricPath: string;
}

// The generated cases graded against a live completed assessment. owner_report +
// delta_report at minimum (delta renders in baseline mode when there is no prior,
// so a single completed assessment is enough). The CIM/teaser rubrics also exist
// (rubrics/) and are exercised by the hermetic unit test; they are intentionally
// NOT listed here because the deterministic CIM/teaser can surface a legitimate
// adjusted-EBITDA "$" figure that their (deliberately strict) no-valuation
// negative would flag — see tests/bench-generated.test.ts and the rubric notes.
export const GENERATED_BENCH_CASES: GeneratedBenchCase[] = [
  {
    name: 'owner_report.generated',
    docType: 'owner_report',
    rubricPath: join(rubricsDir, 'owner_report.baseline.json'),
  },
  {
    name: 'delta_report.generated',
    docType: 'delta_report',
    rubricPath: join(rubricsDir, 'delta_report.baseline.json'),
  },
];

/** Grade every generated bench case against one completed assessment. Requires a
 *  live DB; callers (ci.ts) guard on DATABASE_URL + a completed assessment before
 *  calling. */
export async function runGeneratedBench(
  db: pg.ClientBase,
  assessmentId: string,
): Promise<BenchScore[]> {
  const out: BenchScore[] = [];
  for (const c of GENERATED_BENCH_CASES) {
    const score = await scoreGeneratedDeliverable(db, {
      assessmentId,
      docType: c.docType,
      rubricPath: c.rubricPath,
    });
    out.push({ ...score, name: c.name });
  }
  return out;
}
