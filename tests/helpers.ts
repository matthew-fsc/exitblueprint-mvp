import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { buildRubric } from '../shared/rubric-seed';
import type { Answers, Rubric } from '../shared/scoring/types';

const seedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');

export function loadSeedRubric(): Rubric {
  const read = (f: string) => readFileSync(join(seedDir, f), 'utf8');
  return buildRubric({
    dimensions: read('drs-rubric-dimensions.csv'),
    questions: read('drs-rubric-questions.csv'),
    subScores: read('drs-rubric-subscores.csv'),
    gapDefinitions: read('gap-definitions.csv'),
  });
}

export interface Fixture {
  name: string;
  profile: string;
  answers: Answers;
  expected: {
    sub_scores: Record<string, number>;
    dimension_scores: Record<string, number>;
    drs: number;
    tier: string;
    owner_readiness_index: number;
    gaps: string[];
    flags: string[];
    computed: {
      hhi_est: number;
      top1_pct: number;
      top5_pct: number;
      cagr_pct: number;
      down_years: number;
      pipeline_coverage: number;
    };
  };
}

export const FIXTURE_NAMES = [
  'company-1-meridian-managed-it',
  'company-2-apex-fabrication',
  'company-3-harborview-staffing',
] as const;

export function loadFixture(name: string): Fixture {
  const raw = JSON.parse(readFileSync(join(seedDir, 'fixtures', `${name}.json`), 'utf8'));
  return { name, ...raw };
}

// Beta R1: assessments cannot be created for an engagement without a recorded
// agreement acceptance (gate trigger). Tests that build an engagement then score
// it call this right after creating it. Resolves the firm from the engagement,
// reuses one agreement version per firm, and is idempotent.
export async function acceptAgreement(db: pg.ClientBase, engagementId: string): Promise<void> {
  const firmId = (
    await db.query(`select firm_id from engagements where id = $1`, [engagementId])
  ).rows[0].firm_id as string;
  const versionId =
    ((
      await db.query(
        `select id from agreement_versions where firm_id = $1 and version_label = 'TEST-EA'`,
        [firmId],
      )
    ).rows[0]?.id as string | undefined) ??
    ((
      await db.query(
        `insert into agreement_versions (firm_id, version_label, title, body_md)
         values ($1, 'TEST-EA', 'Test Engagement Agreement', 'test body') returning id`,
        [firmId],
      )
    ).rows[0].id as string);
  await db.query(
    `insert into engagement_agreements (firm_id, engagement_id, agreement_version_id)
     values ($1, $2, $3) on conflict (engagement_id) do nothing`,
    [firmId, engagementId, versionId],
  );
}
