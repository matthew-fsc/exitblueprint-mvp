// Idempotent seed pipeline CLI: loads /seed CSVs and playbook markdown into the
// rubric tables. The load/validate/write logic lives in server/seed-methodology.ts
// so the SAME pipeline can also run from inside the compute service (the
// superadmin-gated `seed-methodology` function) — a hosted beta seeds itself
// without anyone running this script against a production connection string.
// This wrapper just connects, runs it, prints the per-table report, and sets the
// exit code. Usage: DATABASE_URL=... npm run db:seed
import pg from 'pg';
import { SeedValidationError, seedMethodology } from '../server/seed-methodology';

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const db = new pg.Client({ connectionString: url });
  await db.connect();

  let result;
  try {
    result = await seedMethodology(db);
  } catch (err) {
    if (err instanceof SeedValidationError) {
      console.error('seed: referential integrity problems, nothing written:');
      for (const p of err.problems) console.error(`  - ${p}`);
      await db.end();
      process.exit(1);
    }
    await db.end();
    throw err;
  }
  await db.end();

  console.log('seed: table                      inserted  updated  total  expected');
  for (const r of result.rows) {
    console.log(
      `seed: ${r.table.padEnd(26)} ${String(r.inserted).padStart(8)} ${String(r.updated).padStart(8)} ${String(r.total).padStart(6)} ${String(r.expected).padStart(9)}${r.ok ? '' : '  MISMATCH'}`,
    );
  }
  if (!result.ok) {
    console.error('seed: row counts do not match seed files');
    process.exit(1);
  }
  console.log('seed: done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
