// CI entrypoint for the evals. Runs two tiers and exits non-zero if either
// regresses below its tolerance, so a prompt/parser regression fails the build.
// Run: tsx server/llm/evals/ci.ts
//   1. Extraction eval (runner.ts): accuracy of parsed facts vs golden.
//   2. Deliverable bench (bench.ts): per-axis quality of a generated narrative.
// Both tiers are deterministic and secret-free — no DB, no API key on this path.
import pg from 'pg';
import { runAll } from './runner';
import { runBench, runGeneratedBench, BENCH_CASES, subjectiveCriteria, scoreBenchCase } from './bench';
import { readFileSync } from 'node:fs';
import {
  createLLMJudge,
  judgeEnabled,
  judgeDeliverable,
  runJudgeCalibration,
  JUDGE_PROMPT_VERSION,
} from './judge';
import type { BenchRubric } from './bench';

const TOLERANCE = 0.95;
// Per-axis thresholds for the deliverable bench (docs/sellside-ai/02). Answer
// tolerates minor incompleteness; source is exact — a citation that does not
// trace back is never acceptable, so an untraceable claim fails the build.
const ANSWER_TOLERANCE = 0.9;
const SOURCE_TOLERANCE = 1.0;
// The judge tier gates on AGREEMENT with the human golden anchors, not on a raw
// pass rate. A broken judge prompt shows up as anchors it grades wrong. Set below
// 1.0 only to absorb the free economy model's occasional single-anchor wobble on
// an intentionally-off [eval] job; a real prompt regression trips several anchors.
const JUDGE_AGREEMENT_TOLERANCE = 0.8;

async function main() {
  const scores = await runAll();
  let failed = false;
  for (const s of scores) {
    const pct = (s.accuracy * 100).toFixed(1);
    console.log(`eval ${s.name}: ${s.matched}/${s.total} (${pct}%)`);
    for (const m of s.mismatches) {
      console.log(`  mismatch ${m.fact_key}: expected ${m.expected}, got ${m.actual}`);
    }
    if (s.accuracy < TOLERANCE) failed = true;
  }
  if (failed) {
    console.error(`eval failed: accuracy below tolerance ${TOLERANCE}`);
    process.exit(1);
  }
  console.log('eval passed');

  const benchScores = await runBench();
  let benchFailed = false;
  for (const b of benchScores) {
    const ans = (b.answerScore * 100).toFixed(1);
    const src = (b.sourceScore * 100).toFixed(1);
    console.log(`bench ${b.name}: answer ${ans}% · source ${src}%`);
    for (const f of b.failures) {
      console.log(`  ${f}`);
    }
    if (b.answerScore < ANSWER_TOLERANCE || b.sourceScore < SOURCE_TOLERANCE) benchFailed = true;
  }
  if (benchFailed) {
    console.error(
      `bench failed: below tolerance (answer ${ANSWER_TOLERANCE}, source ${SOURCE_TOLERANCE})`,
    );
    process.exit(1);
  }
  console.log('bench passed');

  await runGeneratedTier();
  await runJudgeTier();
}

// --- LLM-judge tier (SECRET-GATED, off the free CI path) -----------------------
// Grades the SUBJECTIVE criteria a regex can't ("explains why a buyer cares in
// plain language"). It is the ONLY tier that can make an API call, so it is
// guarded exactly like the DB-backed generated tier: it runs only when BOTH
// AI_GATEWAY_API_KEY and RUN_LLM_JUDGE are set (judgeEnabled()), and otherwise
// prints a skip note and returns WITHOUT failing. `npm run eval` with no key
// therefore stays deterministic and secret-free — no API call is ever made.
//
// When it runs it does two things: (1) CALIBRATE against the human golden anchors
// (fixtures/judge_golden.json) and fail if agreement drops below tolerance — a
// judge-prompt regression; (2) report the judge axis for each static bench case
// that carries subjective criteria, so the third axis is visible next to answer +
// source. The judge is advisory (rule: anchored to human grades); only the
// calibration gate can fail the build.
async function runJudgeTier() {
  if (!judgeEnabled()) {
    console.log('judge-bench: skipped (set AI_GATEWAY_API_KEY + RUN_LLM_JUDGE for the [eval] job)');
    return;
  }

  const judge = createLLMJudge();
  console.log(`judge-bench: running (prompt_version ${JUDGE_PROMPT_VERSION})`);

  // (1) Calibration gate against the human golden set.
  const cal = await runJudgeCalibration(judge);
  const rate = (cal.agreementRate * 100).toFixed(1);
  console.log(`judge-bench calibration: ${cal.agreements}/${cal.total} anchors agree (${rate}%)`);
  for (const r of cal.results) {
    if (!r.agrees) console.log(`  DISAGREE ${r.id}: expected ${r.expected}, judge ${r.got} — ${r.rationale}`);
  }
  if (cal.agreementRate < JUDGE_AGREEMENT_TOLERANCE) {
    console.error(`judge-bench failed: anchor agreement below tolerance ${JUDGE_AGREEMENT_TOLERANCE}`);
    process.exit(1);
  }

  // (2) Report the judge axis for each static case with subjective criteria.
  for (const c of BENCH_CASES) {
    const rubric = JSON.parse(readFileSync(c.rubricPath, 'utf8')) as BenchRubric;
    if (subjectiveCriteria(rubric).length === 0) continue;
    const markdown = readFileSync(c.deliverablePath, 'utf8');
    const det = scoreBenchCase(c); // deterministic axes, for context
    const axis = await judgeDeliverable(judge, markdown, rubric);
    const js = (axis.judgeScore * 100).toFixed(1);
    const ans = (det.answerScore * 100).toFixed(1);
    const src = (det.sourceScore * 100).toFixed(1);
    console.log(`judge-bench ${c.name}: answer ${ans}% · source ${src}% · judge ${js}% (${axis.passed}/${axis.total})`);
    for (const g of axis.criteria) {
      if (!g.pass) console.log(`  judge FAIL ${g.id}: ${g.rationale}`);
    }
  }
  console.log('judge-bench passed');
}

// --- Generated-deliverable bench (DB-backed, GUARDED) --------------------------
// Grades the deliverable the REAL code path produces (deterministic composer, no
// API key) against a live completed assessment. This tier needs a database, so
// it is OFF the free CI path: it runs only when DATABASE_URL is set AND a
// completed assessment exists, and otherwise prints a skip note and returns
// WITHOUT failing. When it runs it uses the same per-axis tolerances as the
// static bench (answer 0.9, source 1.0).
async function runGeneratedTier() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('generated-bench: skipped (no DATABASE_URL)');
    return;
  }

  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    // A completed, non-superseded assessment to grade (active_assessments is the
    // view narrative.ts builds payloads from; status='completed' is required).
    const found = await db.query(
      `select id from active_assessments where status = 'completed' limit 1`,
    );
    const assessmentId: string | undefined = found.rows[0]?.id;
    if (!assessmentId) {
      console.log('generated-bench: skipped (no completed assessment)');
      return;
    }

    const genScores = await runGeneratedBench(db, assessmentId);
    let genFailed = false;
    for (const g of genScores) {
      const ans = (g.answerScore * 100).toFixed(1);
      const src = (g.sourceScore * 100).toFixed(1);
      console.log(`generated-bench ${g.name}: answer ${ans}% · source ${src}%`);
      for (const f of g.failures) console.log(`  ${f}`);
      if (g.answerScore < ANSWER_TOLERANCE || g.sourceScore < SOURCE_TOLERANCE) genFailed = true;
    }
    if (genFailed) {
      console.error(
        `generated-bench failed: below tolerance (answer ${ANSWER_TOLERANCE}, source ${SOURCE_TOLERANCE})`,
      );
      process.exit(1);
    }
    console.log('generated-bench passed');
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
