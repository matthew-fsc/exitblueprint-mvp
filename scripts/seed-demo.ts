// Demo tenant seed (S4.5 A5): "Blueprint Demo Advisors" with one company and
// the two-snapshot longitudinal story (Needs Work -> Sale Ready over ~9mo).
// Demo data is NOT a correctness fixture — the three /seed/fixtures companies
// remain the only fixtures. As a validation step, this script re-checks that
// the real engine's output matches the reference scorer's expected values
// stored in seed/demo/*.json, and aborts without committing on any mismatch.
// Idempotent and firm-scoped: safe to run anywhere, never touches other firms.
// Usage: DATABASE_URL=... npm run seed:demo
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { scoreAssessment } from '../server/scoring';
import type { Answers } from '../shared/scoring/types';

const DEMO_FIRM = 'Blueprint Demo Advisors';
const DEMO_COMPANY = 'Cascade Facility Services';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface DemoSnapshot {
  profile: string;
  snapshot_date: string;
  answers: Answers;
  expected: {
    sub_scores: Record<string, number>;
    drs: number;
    tier: string;
    owner_readiness_index: number;
    gaps: string[];
  };
}

const snapshots: DemoSnapshot[] = [1, 2].map((n) =>
  JSON.parse(readFileSync(join(root, 'seed', 'demo', `demo-snapshot-${n}.json`), 'utf8')),
);

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const rubricVersion = await db.query(
      `select id from rubric_versions where status = 'active' order by created_at desc limit 1`,
    );
    if (rubricVersion.rowCount === 0) {
      throw new Error('no active rubric version — run npm run db:seed first');
    }
    const rubricVersionId = rubricVersion.rows[0].id;
    const questionIds = new Map<string, string>(
      (
        await db.query(
          `select q.id, q.code from questions q
           join dimensions d on d.id = q.dimension_id
           where d.rubric_version_id = $1`,
          [rubricVersionId],
        )
      ).rows.map((r) => [r.code, r.id]),
    );

    // firms.name is not unique in the schema, so look up before insert.
    let firmId = (
      await db.query(`select id from firms where name = $1 order by created_at limit 1`, [DEMO_FIRM])
    ).rows[0]?.id;
    firmId ??= (
      await db.query(`insert into firms (name) values ($1) returning id`, [DEMO_FIRM])
    ).rows[0].id;

    let companyId = (
      await db.query(`select id from companies where firm_id = $1 and name = $2`, [firmId, DEMO_COMPANY])
    ).rows[0]?.id;
    companyId ??= (
      await db.query(
        `insert into companies (firm_id, name, industry, revenue_band, state, owner_contact_name)
         values ($1, $2, 'Commercial facilities maintenance', '$5M-$10M', 'WA', 'Dana Whitfield')
         returning id`,
        [firmId, DEMO_COMPANY],
      )
    ).rows[0].id;

    let engagementId = (
      await db.query(`select id from engagements where firm_id = $1 and company_id = $2`, [firmId, companyId])
    ).rows[0]?.id;
    engagementId ??= (
      await db.query(
        `insert into engagements (firm_id, company_id, target_exit_window, started_at)
         values ($1, $2, '24-36 months', '2025-09-15') returning id`,
        [firmId, companyId],
      )
    ).rows[0].id;

    for (const [index, snapshot] of snapshots.entries()) {
      const sequence = index + 1;
      const existing = await db.query(
        `select id, status, drs_score from assessments
         where engagement_id = $1 and sequence_number = $2 and record_status = 'active'`,
        [engagementId, sequence],
      );
      if (existing.rowCount) {
        const drs = Number(existing.rows[0].drs_score);
        if (existing.rows[0].status !== 'completed' || drs !== snapshot.expected.drs) {
          throw new Error(
            `demo assessment ${sequence} exists but does not match expected (drs ${drs} vs ${snapshot.expected.drs})`,
          );
        }
        console.log(`seed-demo: assessment ${sequence} already present (DRS ${drs}) — skipped`);
        continue;
      }

      const assessmentId = (
        await db.query(
          `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
           values ($1, $2, $3, $4) returning id`,
          [firmId, engagementId, rubricVersionId, sequence],
        )
      ).rows[0].id;
      for (const [code, value] of Object.entries(snapshot.answers)) {
        const questionId = questionIds.get(code);
        if (!questionId) continue;
        await db.query(
          `insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`,
          [assessmentId, questionId, JSON.stringify(value)],
        );
      }

      // Score with the real engine, then validate against the reference
      // scorer's expected output. Any mismatch aborts loudly.
      const result = await scoreAssessment(db, assessmentId);
      const mismatches: string[] = [];
      if (result.drsScore !== snapshot.expected.drs) mismatches.push(`drs ${result.drsScore} != ${snapshot.expected.drs}`);
      if (result.drsTier !== snapshot.expected.tier) mismatches.push(`tier ${result.drsTier} != ${snapshot.expected.tier}`);
      if (result.oriScore !== snapshot.expected.owner_readiness_index) {
        mismatches.push(`ori ${result.oriScore} != ${snapshot.expected.owner_readiness_index}`);
      }
      if (JSON.stringify(result.gapCodes) !== JSON.stringify(snapshot.expected.gaps)) {
        mismatches.push(`gaps ${result.gapCodes} != ${snapshot.expected.gaps}`);
      }
      for (const [code, points] of Object.entries(snapshot.expected.sub_scores)) {
        const got = result.subScores.find((s) => s.code === code)?.points;
        if (got !== points) mismatches.push(`sub_score ${code} ${got} != ${points}`);
      }
      if (mismatches.length > 0) {
        throw new Error(
          `seed-demo: engine output does not match reference scorer for snapshot ${sequence}:\n  ${mismatches.join('\n  ')}`,
        );
      }
      // Demo storytelling: place the snapshot at its narrative date.
      await db.query(`update assessments set completed_at = $2 where id = $1`, [
        assessmentId,
        snapshot.snapshot_date,
      ]);
      console.log(
        `seed-demo: assessment ${sequence} scored DRS ${result.drsScore} (${result.drsTier}), ` +
          `${result.gapCodes.length} gaps — matches reference scorer`,
      );
    }

    await db.query(
      `insert into engagement_outcomes (firm_id, engagement_id, process_status)
       values ($1, $2, 'preparing')
       on conflict (engagement_id) do nothing`,
      [firmId, engagementId],
    );
    console.log(`seed-demo: done — firm '${DEMO_FIRM}', company '${DEMO_COMPANY}'`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
