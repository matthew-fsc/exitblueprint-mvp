// CI entrypoint for the extraction eval. Runs every golden case and exits
// non-zero if any case scores below TOLERANCE, so a prompt/parser regression
// fails the build. Run: tsx server/llm/evals/ci.ts
import { runAll } from './runner';

const TOLERANCE = 0.95;

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
