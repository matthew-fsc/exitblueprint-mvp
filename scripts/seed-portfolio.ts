// Portfolio demo seed (F2): populates the demo firm with many engagements so
// the advisor dashboard has a realistic book of business. Each engagement is
// built from one of the three real fixture answer sets (rotated, so scores
// vary) and scored by the REAL engine, so clicking through to results/explain
// works exactly like a genuine assessment. Completed dates are spread across
// the last ~18 months so staleness and deltas are visible.
//
// Usage: DATABASE_URL=... npm run seed:portfolio -- [count]   (default 15)
// Idempotent: re-running tops up to `count` engagements, never duplicates.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { scoreAssessment } from '../server/scoring';
import {
  DEFAULT_AGREEMENT_BODY,
  DEFAULT_AGREEMENT_LABEL,
  DEFAULT_AGREEMENT_TITLE,
} from './agreement-template';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const DEMO_FIRM = 'Blueprint Demo Advisors';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURES = [
  'company-1-meridian-managed-it',
  'company-2-apex-fabrication',
  'company-3-harborview-staffing',
] as const;

function fixtureAnswers(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'seed', 'fixtures', `${name}.json`), 'utf8')).answers;
}

// A believable book of lower-middle-market companies.
const NAMES = [
  ['Ridgeline Industrial Coatings', 'Manufacturing'],
  ['Blue Harbor Logistics', 'Transportation'],
  ['Summit Precision Machining', 'Manufacturing'],
  ['Cedar & Stone Landscaping', 'Field services'],
  ['Northwind HVAC Services', 'Field services'],
  ['Beacon Behavioral Health', 'Healthcare services'],
  ['Verdant Facilities Group', 'Facilities'],
  ['Ironclad Security Systems', 'Security'],
  ['Meridian Dental Partners', 'Healthcare services'],
  ['Copperfield Electric', 'Electrical'],
  ['Anchor Marine Supply', 'Distribution'],
  ['Sterling Plastics', 'Manufacturing'],
  ['Trailhead Outdoor Brands', 'Consumer goods'],
  ['Lattice Software Group', 'Software'],
  ['Granite Peak Roofing', 'Construction'],
  ['Willow Creek Foods', 'Food & beverage'],
  ['Halcyon Aesthetics', 'Healthcare services'],
  ['Pinnacle Staffing Group', 'Staffing'],
  ['Riverstone Accounting', 'Professional services'],
  ['Kestrel Aerospace Components', 'Manufacturing'],
] as const;

async function main() {
  const count = Math.max(1, Math.min(50, Number(process.argv[2] ?? 15)));
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const firmId = (
      await db.query(`select id from firms where name = $1 order by created_at limit 1`, [DEMO_FIRM])
    ).rows[0]?.id;
    if (!firmId) throw new Error(`demo firm '${DEMO_FIRM}' not found — run npm run seed:demo first`);

    const advisorId = (
      await db.query(`select id from profiles where firm_id = $1 and role = 'advisor' limit 1`, [firmId])
    ).rows[0]?.id ?? null;

    const rubric = (
      await db.query(`select id from rubric_versions where status = 'active' order by created_at desc limit 1`)
    ).rows[0];
    if (!rubric) throw new Error('no active rubric version — run npm run db:seed');
    const questionIds = new Map<string, string>(
      (
        await db.query(
          `select q.id, q.code from questions q join dimensions d on d.id = q.dimension_id
           where d.rubric_version_id = $1`,
          [rubric.id],
        )
      ).rows.map((r) => [r.code, r.id]),
    );

    // Beta R1: every engagement needs an agreement acceptance before any
    // assessment can be created. Ensure the firm's agreement version once.
    let agreementVersionId = (
      await db.query(`select id from agreement_versions where firm_id = $1 and version_label = $2`, [
        firmId,
        DEFAULT_AGREEMENT_LABEL,
      ])
    ).rows[0]?.id;
    agreementVersionId ??= (
      await db.query(
        `insert into agreement_versions (firm_id, version_label, title, body_md, status)
         values ($1, $2, $3, $4, 'active') returning id`,
        [firmId, DEFAULT_AGREEMENT_LABEL, DEFAULT_AGREEMENT_TITLE, DEFAULT_AGREEMENT_BODY],
      )
    ).rows[0].id;

    const fixtureCache = new Map(FIXTURES.map((f) => [f, fixtureAnswers(f)]));

    const createAssessment = async (
      engagementId: string,
      seq: number,
      answers: Record<string, unknown>,
      completedAt: string,
    ) => {
      const assessmentId = (
        await db.query(
          `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
           values ($1, $2, $3, $4) returning id`,
          [firmId, engagementId, rubric.id, seq],
        )
      ).rows[0].id;
      for (const [code, value] of Object.entries(answers)) {
        const qid = questionIds.get(code);
        if (!qid) continue;
        await db.query(`insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`, [
          assessmentId,
          qid,
          JSON.stringify(value),
        ]);
      }
      await scoreAssessment(db, assessmentId);
      await db.query(`update assessments set completed_at = $2 where id = $1`, [assessmentId, completedAt]);
      return assessmentId;
    };

    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

    const nameFor = (i: number): readonly [string, string] =>
      i < NAMES.length ? NAMES[i] : [`Portfolio Company ${i + 1}`, 'Lower middle market'];

    let created = 0;
    for (let i = 0; i < count; i++) {
      const [name, industry] = nameFor(i);
      const existing = await db.query(`select id from companies where firm_id = $1 and name = $2`, [firmId, name]);
      if (existing.rowCount) continue;

      const companyId = (
        await db.query(
          `insert into companies (firm_id, name, industry) values ($1, $2, $3) returning id`,
          [firmId, name, industry],
        )
      ).rows[0].id;
      const engagementId = (
        await db.query(
          `insert into engagements (firm_id, company_id, advisor_id, target_exit_window)
           values ($1, $2, $3, $4) returning id`,
          [firmId, companyId, advisorId, ['12-24 months', '24-36 months', '36+ months'][i % 3]],
        )
      ).rows[0].id;
      await db.query(
        `insert into engagement_agreements
           (firm_id, engagement_id, agreement_version_id, accepted_signer_name,
            consent_benchmarking, consent_anonymized_aggregation, consent_outcome_tracking)
         values ($1, $2, $3, 'Portfolio seed', true, true, true)
         on conflict (engagement_id) do nothing`,
        [firmId, engagementId, agreementVersionId],
      );

      // Rotate the baseline fixture; some engagements get a second, improved
      // assessment (a positive delta) using a stronger fixture.
      const baseFixture = FIXTURES[i % 3];
      const baseline = fixtureCache.get(baseFixture)!;
      const staleness = [20, 45, 70, 110, 160, 200][i % 6]; // some > 90 days (stale)
      await createAssessment(engagementId, 1, baseline, daysAgo(staleness + 180));

      // ~60% get a reassessment; improvement fixture gives an upward delta.
      if (i % 5 !== 0) {
        const improved = fixtureCache.get(FIXTURES[(i + 2) % 3])!;
        await createAssessment(engagementId, 2, improved, daysAgo(staleness));
      }
      created++;
    }

    console.log(`seed-portfolio: ensured ${count} engagements in '${DEMO_FIRM}' (${created} newly created)`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
