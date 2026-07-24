// CI entrypoint for the evals. Runs two tiers and exits non-zero if either
// regresses below its tolerance, so a prompt/parser regression fails the build.
// Run: tsx server/llm/evals/ci.ts
//   1. Extraction eval (runner.ts): accuracy of parsed facts vs golden.
//   2. Deliverable bench (bench.ts): per-axis quality of a generated narrative.
// Both tiers are deterministic and secret-free — no DB, no API key on this path.
import pg from 'pg';
import { runAll } from './runner';
import { runBench, runGeneratedBench } from './bench';

const TOLERANCE = 0.95;
// Per-axis thresholds for the deliverable bench (docs/sellside-ai/02). Answer
// tolerates minor incompleteness; source is exact — a citation that does not
// trace back is never acceptable, so an untraceable claim fails the build.
const ANSWER_TOLERANCE = 0.9;
const SOURCE_TOLERANCE = 1.0;

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
