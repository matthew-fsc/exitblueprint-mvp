// Idempotent seed pipeline: loads /seed CSVs and playbook markdown into the
// rubric tables. Upserts on code fields, validates referential integrity
// before writing, and reports inserted/updated/total counts per table.
// Usage: DATABASE_URL=... npm run db:seed
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  buildRubric,
  parseContentModules,
  parseGapContentMap,
  parseGapPlaybookMap,
  parsePlaybook,
  validateRubric,
} from '../shared/rubric-seed';

const RUBRIC_VERSION_LABEL = 'DRS-1.0';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const seedDir = join(root, 'seed');
const read = (f: string) => readFileSync(join(seedDir, f), 'utf8');

interface Counts {
  inserted: number;
  updated: number;
}
const report: Record<string, Counts> = {};
function tally(table: string, wasInserted: boolean) {
  report[table] ??= { inserted: 0, updated: 0 };
  report[table][wasInserted ? 'inserted' : 'updated']++;
}

async function main() {
  const rubric = buildRubric({
    dimensions: read('drs-rubric-dimensions.csv'),
    questions: read('drs-rubric-questions.csv'),
    subScores: read('drs-rubric-subscores.csv'),
    gapDefinitions: read('gap-definitions.csv'),
  });
  const playbooks = readdirSync(join(seedDir, 'playbooks'))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parsePlaybook(readFileSync(join(seedDir, 'playbooks', f), 'utf8')));
  const contentModules = parseContentModules(read('content-modules.csv'));
  const gapPlaybookMap = parseGapPlaybookMap(read('gap-playbook-map.csv'));
  const gapContentMap = parseGapContentMap(read('gap-content-map.csv'));

  const problems = validateRubric(rubric, playbooks, contentModules, gapPlaybookMap, gapContentMap);
  if (problems.length > 0) {
    console.error('seed: referential integrity problems, nothing written:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const db = new pg.Client({ connectionString: url });
  await db.connect();

  // `xmax = 0` distinguishes an insert from an update in an upsert.
  const upsert = async (table: string, sql: string, params: unknown[]): Promise<string> => {
    const res = await db.query(sql, params);
    tally(table, res.rows[0].inserted);
    return res.rows[0].id;
  };

  try {
    await db.query('begin');

    const rubricVersionId = await upsert(
      'rubric_versions',
      `insert into rubric_versions (version_label, status, effective_date)
       values ($1, 'active', current_date)
       on conflict (version_label) do update set status = 'active'
       returning id, (xmax = 0) as inserted`,
      [RUBRIC_VERSION_LABEL],
    );

    const dimensionIds: Record<string, string> = {};
    for (const d of rubric.dimensions) {
      dimensionIds[d.code] = await upsert(
        'dimensions',
        `insert into dimensions (rubric_version_id, code, name, score_group, drs_weight, sort_order)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (rubric_version_id, code) do update
           set name = excluded.name, score_group = excluded.score_group,
               drs_weight = excluded.drs_weight, sort_order = excluded.sort_order
         returning id, (xmax = 0) as inserted`,
        [rubricVersionId, d.code, d.name, d.scoreGroup, d.drsWeight, d.sortOrder],
      );
    }

    for (const q of rubric.questions) {
      await upsert(
        'questions',
        `insert into questions (dimension_id, code, prompt, answer_type, options, scored, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (dimension_id, code) do update
           set prompt = excluded.prompt, answer_type = excluded.answer_type,
               options = excluded.options, scored = excluded.scored, sort_order = excluded.sort_order
         returning id, (xmax = 0) as inserted`,
        [dimensionIds[q.dimensionCode], q.code, q.prompt, q.answerType, q.options, q.scored, q.sortOrder],
      );
    }

    for (const s of rubric.subScores) {
      await upsert(
        'sub_scores',
        `insert into sub_scores (dimension_id, code, name, weight, formula_type, input_question_codes, logic, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (dimension_id, code) do update
           set name = excluded.name, weight = excluded.weight, formula_type = excluded.formula_type,
               input_question_codes = excluded.input_question_codes, logic = excluded.logic,
               notes = excluded.notes
         returning id, (xmax = 0) as inserted`,
        [dimensionIds[s.dimensionCode], s.code, s.name, s.weight, s.formulaType,
         s.inputQuestionCodes.join(','), JSON.stringify(s.logic), s.notes],
      );
    }

    const gapIds: Record<string, string> = {};
    for (const g of rubric.gapDefinitions) {
      gapIds[g.code] = await upsert(
        'gap_definitions',
        `insert into gap_definitions (rubric_version_id, code, name, severity, dimension_id, trigger)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (rubric_version_id, code) do update
           set name = excluded.name, severity = excluded.severity,
               dimension_id = excluded.dimension_id, trigger = excluded.trigger
         returning id, (xmax = 0) as inserted`,
        [rubricVersionId, g.code, g.name, g.severity, dimensionIds[g.dimensionCode],
         JSON.stringify(g.trigger)],
      );
    }

    const playbookIds: Record<string, string> = {};
    for (const p of playbooks) {
      playbookIds[p.code] = await upsert(
        'playbooks',
        `insert into playbooks (code, name, version, summary, dimension_code, phase, ev_impact, body_md)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (code, version) do update
           set name = excluded.name, summary = excluded.summary,
               dimension_code = excluded.dimension_code, phase = excluded.phase,
               ev_impact = excluded.ev_impact, body_md = excluded.body_md
         returning id, (xmax = 0) as inserted`,
        [p.code, p.name, p.version, p.summary, p.dimensionCode, p.phase, p.evImpact, p.bodyMd],
      );
      for (const t of p.tasks) {
        await upsert(
          'playbook_task_templates',
          `insert into playbook_task_templates (playbook_id, title, default_owner_role, sequence, target_offset_days)
           values ($1, $2, $3, $4, $5)
           on conflict (playbook_id, sequence) do update
             set title = excluded.title, default_owner_role = excluded.default_owner_role,
                 target_offset_days = excluded.target_offset_days
           returning id, (xmax = 0) as inserted`,
          [playbookIds[p.code], t.title, t.ownerRole, t.sequence, t.offsetDays],
        );
      }
      // Remove templates dropped from the playbook file.
      await db.query(
        'delete from playbook_task_templates where playbook_id = $1 and sequence > $2',
        [playbookIds[p.code], p.tasks.length],
      );
    }

    const contentIds: Record<string, string> = {};
    for (const c of contentModules) {
      contentIds[c.code] = await upsert(
        'content_modules',
        `insert into content_modules (code, title, dimension_code, body_md)
         values ($1, $2, $3, $4)
         on conflict (code) do update
           set title = excluded.title, dimension_code = excluded.dimension_code,
               body_md = excluded.body_md
         returning id, (xmax = 0) as inserted`,
        [c.code, c.title, c.dimensionCode, c.body],
      );
    }

    for (const m of gapPlaybookMap) {
      await upsert(
        'gap_playbook_map',
        `insert into gap_playbook_map (gap_definition_id, playbook_id, priority)
         values ($1, $2, $3)
         on conflict (gap_definition_id, playbook_id) do update set priority = excluded.priority
         returning id, (xmax = 0) as inserted`,
        [gapIds[m.fromCode], playbookIds[m.toCode], m.order],
      );
    }

    for (const m of gapContentMap) {
      await upsert(
        'gap_content_map',
        `insert into gap_content_map (gap_definition_id, content_module_id, drip_order)
         values ($1, $2, $3)
         on conflict (gap_definition_id, content_module_id) do update set drip_order = excluded.drip_order
         returning id, (xmax = 0) as inserted`,
        [gapIds[m.fromCode], contentIds[m.toCode], m.order],
      );
    }

    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }

  // Report and verify end-state row counts against the seed files.
  const expected: Record<string, number> = {
    rubric_versions: 1,
    dimensions: rubric.dimensions.length,
    questions: rubric.questions.length,
    sub_scores: rubric.subScores.length,
    gap_definitions: rubric.gapDefinitions.length,
    playbooks: playbooks.length,
    playbook_task_templates: playbooks.reduce((n, p) => n + p.tasks.length, 0),
    content_modules: contentModules.length,
    gap_playbook_map: gapPlaybookMap.length,
    gap_content_map: gapContentMap.length,
  };
  let mismatched = false;
  console.log('seed: table                      inserted  updated  total  expected');
  for (const [table, want] of Object.entries(expected)) {
    const { inserted = 0, updated = 0 } = report[table] ?? {};
    const total = Number(
      (await db.query(`select count(*)::int as c from ${table}`)).rows[0].c,
    );
    const ok = total === want;
    if (!ok) mismatched = true;
    console.log(
      `seed: ${table.padEnd(26)} ${String(inserted).padStart(8)} ${String(updated).padStart(8)} ${String(total).padStart(6)} ${String(want).padStart(9)}${ok ? '' : '  MISMATCH'}`,
    );
  }
  await db.end();
  if (mismatched) {
    console.error('seed: row counts do not match seed files');
    process.exit(1);
  }
  console.log('seed: done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
