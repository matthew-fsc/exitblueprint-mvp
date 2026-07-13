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
  parseAdvisoryLibrary,
  parseContentModules,
  parseGapContentMap,
  parseGapPlaybookMap,
  parsePlaybook,
  parseValuationMultiples,
  validateRubric,
} from '../shared/rubric-seed';

// Phase 2 valuation rules (Matthew's approved starters; edit by adding a version).
const VALUATION_VERSION_LABEL = 'VAL-1.0';
const VALUATION_CONFIG = {
  size_bands: [
    { key: 'lt_1m', max: 1_000_000 },
    { key: '1_3m', max: 3_000_000 },
    { key: '3_5m', max: 5_000_000 },
    { key: 'gt_5m', max: null },
  ],
  readiness_adjustments: {
    'Institutional Grade': 1.15,
    'Sale Ready': 1.0,
    'Needs Work': 0.85,
    'High Risk': 0.7,
    'Not Saleable (Yet)': 0.55,
  },
  verification_widths: { document_verified: 0.1, partly_verified: 0.2, self_reported: 0.3 },
  transaction_cost_pct: 0.08,
  default_tax_rate: 0.28,
  target_drs: 85,
};

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
  const advisoryItems = parseAdvisoryLibrary(read('advisory-library.csv'));
  const valuationMultiples = parseValuationMultiples(read('valuation-multiples.csv'));

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

    // Advisory Library: global (firm_id null) system catalog, keyed by code.
    for (const a of advisoryItems) {
      await upsert(
        'advisory_library_items',
        `insert into advisory_library_items
           (firm_id, source, item_type, code, title, body, response_framework,
            data_needed, dimension_code, sub_score_code, severity, buyer_type,
            score_trigger, sort_order)
         values (null, 'system', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (code) where firm_id is null do update
           set item_type = excluded.item_type, title = excluded.title, body = excluded.body,
               response_framework = excluded.response_framework, data_needed = excluded.data_needed,
               dimension_code = excluded.dimension_code, sub_score_code = excluded.sub_score_code,
               severity = excluded.severity, buyer_type = excluded.buyer_type,
               score_trigger = excluded.score_trigger, sort_order = excluded.sort_order
         returning id, (xmax = 0) as inserted`,
        [
          a.itemType, a.code, a.title, a.body, a.responseFramework, a.dataNeeded,
          a.dimensionCode, a.subScoreCode, a.severity, a.buyerType, a.scoreTrigger, a.sortOrder,
        ],
      );
    }

    // Valuation rules: one active version holding the config, plus the multiples.
    const valuationVersionId = await upsert(
      'valuation_rules_versions',
      `insert into valuation_rules_versions (version_label, status, effective_date, config)
       values ($1, 'active', current_date, $2)
       on conflict (version_label) do update set status = 'active', config = excluded.config
       returning id, (xmax = 0) as inserted`,
      [VALUATION_VERSION_LABEL, JSON.stringify(VALUATION_CONFIG)],
    );
    for (const m of valuationMultiples) {
      await upsert(
        'valuation_multiples',
        `insert into valuation_multiples (rules_version_id, industry_key, size_band, base_multiple)
         values ($1, $2, $3, $4)
         on conflict (rules_version_id, industry_key, size_band) do update set base_multiple = excluded.base_multiple
         returning id, (xmax = 0) as inserted`,
        [valuationVersionId, m.industryKey, m.sizeBand, m.baseMultiple],
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
    advisory_library_items: advisoryItems.length,
    valuation_rules_versions: 1,
    valuation_multiples: valuationMultiples.length,
  };
  let mismatched = false;
  console.log('seed: table                      inserted  updated  total  expected');
  // Tables that also hold tenant rows: verify only the seeded (system) rows.
  const countFilter: Record<string, string> = {
    advisory_library_items: 'where firm_id is null',
  };
  for (const [table, want] of Object.entries(expected)) {
    const { inserted = 0, updated = 0 } = report[table] ?? {};
    const total = Number(
      (await db.query(`select count(*)::int as c from ${table} ${countFilter[table] ?? ''}`)).rows[0].c,
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
