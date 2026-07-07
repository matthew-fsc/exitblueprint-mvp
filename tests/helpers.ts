import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
