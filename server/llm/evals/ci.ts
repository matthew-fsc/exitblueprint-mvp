// CI entrypoint for the evals. Runs two tiers and exits non-zero if either
// regresses below its tolerance, so a prompt/parser regression fails the build.
// Run: tsx server/llm/evals/ci.ts
//   1. Extraction eval (runner.ts): accuracy of parsed facts vs golden.
//   2. Deliverable bench (bench.ts): per-axis quality of a generated narrative.
// Both tiers are deterministic and secret-free — no DB, no API key on this path.
import { runAll } from './runner';
import { runBench } from './bench';

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
