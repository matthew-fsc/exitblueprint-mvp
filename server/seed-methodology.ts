// The methodology seed pipeline, factored out of scripts/seed.ts so it can run
// from TWO places against the same logic:
//   - the CLI (scripts/seed.ts) — `npm run db:seed`, for local dev / CI, and
//   - the compute service (a superadmin-gated `seed-methodology` function) —
//     so a hosted beta can load its own methodology from inside the system
//     instead of someone running the CLI with a production connection string.
//
// It loads the canonical /seed CSVs + playbook markdown, validates referential
// integrity (nothing is written if validation fails), upserts every methodology
// table inside one transaction (idempotent — upserts on the code fields), then
// verifies end-state row counts against the seed files. This is METHODOLOGY
// (global, firm_id null), never tenant data, so it always runs with the
// service-role client that bypasses RLS (CLAUDE.md rules 1 & 3).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { applyMigrations } from './migrate';
import {
  buildRubric,
  parseAdvisoryLibrary,
  parseContentModules,
  parseGapContentMap,
  parseGapPlaybookMap,
  parseDataRoomItems,
  parseDataRoomSections,
  parsePlaybook,
  parseValuationMultiples,
  validateDataRoom,
  validateRubric,
} from '../shared/rubric-seed';

// Phase 2 valuation rules (Matthew's approved starters; edit by adding a version).
export const VALUATION_VERSION_LABEL = 'VAL-1.0';
export const VALUATION_CONFIG = {
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

export const RUBRIC_VERSION_LABEL = 'DRS-1.0';

// Starter system Plans (docs/37): canonical, advisor-facing initiative bundles,
// seeded as GLOBAL methodology (firm_id null) exactly like the rubric/advisory
// catalog. Curated inline (like VALUATION_CONFIG above) because the set is small
// and relational-by-code; every referenced code is validated against the parsed
// playbooks/content/advisory before anything is written. Composes only GLOBAL
// assets so every firm can safely read them (docs/37 §5). Edit by adding items
// or a new plan; a methodology change to a shipped Plan bumps plan_version.
export interface SeedPlanItem {
  kind: 'playbook' | 'education' | 'advisory' | 'milestone' | 'manual_task';
  playbookCode?: string; // kind 'playbook'
  contentModuleCode?: string; // kind 'education'
  advisoryCode?: string; // kind 'advisory'
  title?: string; // kind 'milestone' | 'manual_task'
  description?: string;
  ownerRole?: string; // kind 'manual_task'
  track?: 'business' | 'personal'; // kind 'milestone'
  targetOffsetDays?: number;
}
export interface SeedPlan {
  code: string;
  name: string;
  summary: string;
  items: SeedPlanItem[];
}
export const SYSTEM_PLANS: SeedPlan[] = [
  {
    code: 'PL-FIN-CLEANUP',
    name: 'Phase 1 Financial Cleanup',
    summary:
      'Get the financials buyer-ready: clean books, documented addbacks, and the EBITDA recast a buyer will actually underwrite.',
    items: [
      { kind: 'playbook', playbookCode: 'PB-CLEAN-BOOKS' },
      { kind: 'playbook', playbookCode: 'PB-ADDBACK-DOC' },
      { kind: 'education', contentModuleCode: 'CM-EDU-EBITDA-RECAST' },
      { kind: 'advisory', advisoryCode: 'AL-BQ-ADDBACKS' },
      {
        kind: 'milestone',
        title: 'Financials are buyer-ready (clean books + documented addbacks)',
        track: 'business',
      },
    ],
  },
  {
    code: 'PL-OWNER-DEP',
    name: 'Owner-Dependence Reduction',
    summary:
      'Reduce the business’s reliance on the owner: extract the owner from operations and build management depth so the company runs without them.',
    items: [
      { kind: 'playbook', playbookCode: 'PB-OWNER-EXTRACT' },
      { kind: 'playbook', playbookCode: 'PB-MGMT-DEPTH' },
      { kind: 'education', contentModuleCode: 'CM-BUYERQ-OWNER' },
      { kind: 'advisory', advisoryCode: 'AL-BQ-OWNER' },
      {
        kind: 'milestone',
        title: 'Business operates 30 days without owner involvement',
        track: 'business',
      },
    ],
  },
  {
    code: 'PL-CUST-CONC',
    name: 'Customer Concentration Reduction',
    summary:
      'Diversify the customer base and prepare the concentration story a buyer will probe.',
    items: [
      { kind: 'playbook', playbookCode: 'PB-CUST-DIVERSIFY' },
      { kind: 'education', contentModuleCode: 'CM-BUYERQ-CONC' },
      { kind: 'advisory', advisoryCode: 'AL-BQ-CONC' },
      {
        kind: 'manual_task',
        title: 'Map revenue share of the top 10 customers',
        ownerRole: 'owner',
      },
    ],
  },
  {
    code: 'PL-RECURRING',
    name: 'Recurring-Revenue Conversion',
    summary:
      'Move project and transactional revenue toward contracted, recurring relationships a buyer will underwrite — and make that revenue bankable.',
    items: [
      { kind: 'playbook', playbookCode: 'PB-RECURRING-CONVERT' },
      { kind: 'playbook', playbookCode: 'PB-RETENTION-NRR' },
      { kind: 'education', contentModuleCode: 'CM-EDU-DURABILITY' },
      { kind: 'advisory', advisoryCode: 'AL-BQ-RECURRING' },
      {
        kind: 'milestone',
        title: 'Majority of revenue is under contract or recurring, with renewal history',
        track: 'business',
      },
    ],
  },
  {
    code: 'PL-GROWTH',
    name: 'Growth & Positioning',
    summary:
      'Turn the growth story into evidence a buyer can count on: a measured pipeline, repeatable delivery, and a defensible reason customers choose you.',
    items: [
      { kind: 'playbook', playbookCode: 'PB-GROWTH-ENGINE' },
      { kind: 'education', contentModuleCode: 'CM-EDU-POSITIONING' },
      { kind: 'advisory', advisoryCode: 'AL-BQ-GROWTH' },
      {
        kind: 'milestone',
        title: 'Forward pipeline covers the next-year growth target with tracked conversion',
        track: 'business',
      },
    ],
  },
  {
    code: 'PL-QOE',
    name: 'Quality-of-Earnings Readiness',
    summary:
      'Get the numbers ready to survive the buyer’s Quality of Earnings without a retrade: clean books, substantiated addbacks, and a defensible working-capital peg.',
    items: [
      { kind: 'playbook', playbookCode: 'PB-CLEAN-BOOKS' },
      { kind: 'playbook', playbookCode: 'PB-ADDBACK-DOC' },
      { kind: 'playbook', playbookCode: 'PB-QOE-PREP' },
      { kind: 'playbook', playbookCode: 'PB-WORKING-CAPITAL' },
      { kind: 'education', contentModuleCode: 'CM-EDU-QOE' },
      {
        kind: 'milestone',
        title: 'Sell-side quality-of-earnings complete; addbacks substantiated and peg set',
        track: 'business',
      },
    ],
  },
  {
    code: 'PL-MGMT',
    name: 'Management & Key-Person Bench',
    summary:
      'Build the management layer and secure the people a buyer is buying, so the business survives the owner and any single leader’s departure.',
    items: [
      { kind: 'playbook', playbookCode: 'PB-MGMT-DEPTH' },
      { kind: 'playbook', playbookCode: 'PB-NONCOMPETES' },
      { kind: 'playbook', playbookCode: 'PB-COMP-BENCHMARK' },
      { kind: 'education', contentModuleCode: 'CM-EDU-KEY-PERSON' },
      {
        kind: 'milestone',
        title: 'Every core function has a named, retained owner below the seller',
        track: 'business',
      },
    ],
  },
  {
    code: 'PL-OWNER-READY',
    name: 'Owner Personal Readiness',
    summary:
      'Align the owner’s personal and financial readiness with the business plan — quantify the value gap and set the target against the owner’s number and timeline.',
    items: [
      { kind: 'playbook', playbookCode: 'PB-VALUE-GAP-PLAN' },
      { kind: 'education', contentModuleCode: 'CM-EDU-OWNER-READINESS' },
      { kind: 'education', contentModuleCode: 'CM-EDU-WEALTH-GAP' },
      {
        kind: 'milestone',
        title: 'Value gap quantified and target set with the owner’s financial advisor',
        track: 'personal',
      },
    ],
  },
  {
    code: 'PL-GTM',
    name: 'Go-to-Market Readiness',
    summary:
      'Prepare the owner for how a sale actually runs — the process, the buyer types, and the deal structure — so diligence holds no surprises.',
    items: [
      { kind: 'education', contentModuleCode: 'CM-EDU-DEAL-PROCESS' },
      { kind: 'education', contentModuleCode: 'CM-EDU-BUYER-TYPES' },
      { kind: 'education', contentModuleCode: 'CM-EDU-DEAL-STRUCTURE' },
      { kind: 'advisory', advisoryCode: 'AL-BQ-WORKCAP' },
      {
        kind: 'milestone',
        title: 'Owner and advisor aligned on process, target buyer, and deal structure',
        track: 'personal',
      },
    ],
  },
];

// Validate every system Plan item references a real seeded code, and that inline
// items carry their required fields. Returns problem strings (nothing is written
// if any exist), matching the rubric/data-room validation contract.
export function validateSystemPlans(
  plans: SeedPlan[],
  playbookCodes: Set<string>,
  contentCodes: Set<string>,
  advisoryCodes: Set<string>,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of plans) {
    if (seen.has(p.code)) problems.push(`plan ${p.code}: duplicate plan code`);
    seen.add(p.code);
    if (p.items.length === 0) problems.push(`plan ${p.code}: has no items`);
    p.items.forEach((it, i) => {
      const at = `plan ${p.code} item ${i} (${it.kind})`;
      if (it.kind === 'playbook') {
        if (!it.playbookCode) problems.push(`${at}: missing playbookCode`);
        else if (!playbookCodes.has(it.playbookCode)) problems.push(`${at}: unknown playbook ${it.playbookCode}`);
      } else if (it.kind === 'education') {
        if (!it.contentModuleCode) problems.push(`${at}: missing contentModuleCode`);
        else if (!contentCodes.has(it.contentModuleCode)) problems.push(`${at}: unknown content module ${it.contentModuleCode}`);
      } else if (it.kind === 'advisory') {
        if (!it.advisoryCode) problems.push(`${at}: missing advisoryCode`);
        else if (!advisoryCodes.has(it.advisoryCode)) problems.push(`${at}: unknown advisory item ${it.advisoryCode}`);
      } else if (it.kind === 'milestone') {
        if (!it.title) problems.push(`${at}: milestone needs a title`);
        if (it.track !== 'business' && it.track !== 'personal') problems.push(`${at}: milestone needs track business|personal`);
      } else if (it.kind === 'manual_task') {
        if (!it.title) problems.push(`${at}: manual_task needs a title`);
      }
    });
  }
  return problems;
}

// Where the canonical seed files live. Resolved relative to this module so it
// works both under tsx (dev/CLI, repo root) and in the compute image, where the
// Dockerfile copies /seed next to /server and /shared. Overridable via SEED_DIR.
export function resolveSeedDir(): string {
  return process.env.SEED_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');
}

// Referential-integrity failure — the seed writes NOTHING when this is thrown,
// matching the CLI's "nothing written" contract. Carries the problem list so the
// CLI can print it and the function endpoint can surface it to the caller.
export class SeedValidationError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`seed: ${problems.length} referential integrity problem(s), nothing written`);
    this.name = 'SeedValidationError';
    this.problems = problems;
  }
}

export interface SeedTableReport {
  table: string;
  inserted: number;
  updated: number;
  total: number;
  expected: number;
  ok: boolean;
}

export interface SeedResult {
  rows: SeedTableReport[];
  ok: boolean;
  // Migration files applied by this call before seeding (empty when the schema
  // was already current). Set only on the seedMethodology path — writeSeedBundle
  // alone never migrates.
  migrations?: string[];
}

// Parsed, validated methodology ready to write. Kept as a separate step so the
// (pure, no-DB) validation can run and fail before any connection is touched.
export interface SeedBundle {
  rubric: ReturnType<typeof buildRubric>;
  playbooks: ReturnType<typeof parsePlaybook>[];
  contentModules: ReturnType<typeof parseContentModules>;
  gapPlaybookMap: ReturnType<typeof parseGapPlaybookMap>;
  gapContentMap: ReturnType<typeof parseGapContentMap>;
  advisoryItems: ReturnType<typeof parseAdvisoryLibrary>;
  valuationMultiples: ReturnType<typeof parseValuationMultiples>;
  dataRoomSections: ReturnType<typeof parseDataRoomSections>;
  dataRoomItems: ReturnType<typeof parseDataRoomItems>;
}

// Load + parse + validate the /seed files. Throws SeedValidationError on any
// referential-integrity problem (nothing is written by a later writeSeedBundle).
export function loadSeedBundle(seedDir = resolveSeedDir()): SeedBundle {
  const read = (f: string) => readFileSync(join(seedDir, f), 'utf8');
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
  const dataRoomSections = parseDataRoomSections(read('data-room-sections.csv'));
  const dataRoomItems = parseDataRoomItems(read('data-room-items.csv'));

  const problems = [
    ...validateRubric(rubric, playbooks, contentModules, gapPlaybookMap, gapContentMap),
    ...validateDataRoom(dataRoomSections, dataRoomItems, rubric.gapDefinitions),
    ...validateSystemPlans(
      SYSTEM_PLANS,
      new Set(playbooks.map((p) => p.code)),
      new Set(contentModules.map((c) => c.code)),
      new Set(advisoryItems.map((a) => a.code)),
    ),
  ];
  if (problems.length > 0) throw new SeedValidationError(problems);

  return {
    rubric,
    playbooks,
    contentModules,
    gapPlaybookMap,
    gapContentMap,
    advisoryItems,
    valuationMultiples,
    dataRoomSections,
    dataRoomItems,
  };
}

// Write a validated bundle into the methodology tables inside one transaction,
// then verify end-state row counts against the seed files. Idempotent: every
// statement upserts on its code field(s). `db` must be a service-role client
// (RLS bypass) — the CLI's pg.Client, or the compute service's pooled client.
export async function writeSeedBundle(db: pg.ClientBase, bundle: SeedBundle): Promise<SeedResult> {
  const {
    rubric,
    playbooks,
    contentModules,
    gapPlaybookMap,
    gapContentMap,
    advisoryItems,
    valuationMultiples,
    dataRoomSections,
    dataRoomItems,
  } = bundle;

  const report: Record<string, { inserted: number; updated: number }> = {};
  const tally = (table: string, wasInserted: boolean) => {
    report[table] ??= { inserted: 0, updated: 0 };
    report[table][wasInserted ? 'inserted' : 'updated']++;
  };
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

    // Playbooks are retired (docs/06): each seed playbook becomes (a) a set of
    // system library_tasks (the atomic, reusable Library item) and (b) a "recipe"
    // Plan (plan_templates, same code/name/summary as the old playbook) carrying
    // those tasks as 'task' items. A gap maps to this recipe Plan via gap_plan_map;
    // the higher-level curated SYSTEM_PLANS reference the same library_tasks.
    //
    // Clear all SYSTEM plan items up front so orphan library_tasks can be dropped
    // without FK violations, then rebuild every system Plan's items below.
    await db.query(`delete from plan_template_items where firm_id is null`);

    const libraryTasksByPlaybook: Record<string, { id: string; code: string }[]> = {};
    const recipePlanIdByPlaybook: Record<string, string> = {};
    for (const p of playbooks) {
      const taskRefs: { id: string; code: string }[] = [];
      for (const t of p.tasks) {
        const code = `${p.code}-T${t.sequence}`;
        const id = await upsert(
          'library_tasks',
          `insert into library_tasks
             (firm_id, source, code, title, default_owner_role, dimension_code, target_offset_days)
           values (null, 'system', $1, $2, $3, $4, $5)
           on conflict (code) where firm_id is null do update
             set title = excluded.title, default_owner_role = excluded.default_owner_role,
                 dimension_code = excluded.dimension_code, target_offset_days = excluded.target_offset_days
           returning id, (xmax = 0) as inserted`,
          [code, t.title, t.ownerRole, p.dimensionCode, t.offsetDays],
        );
        taskRefs.push({ id, code });
      }
      libraryTasksByPlaybook[p.code] = taskRefs;
      // Drop system library tasks removed from the playbook file (safe: system
      // plan items were cleared above).
      await db.query(
        `delete from library_tasks
         where firm_id is null and code like $1 and not (code = any($2::text[]))`,
        [`${p.code}-T%`, taskRefs.map((r) => r.code)],
      );

      // The recipe Plan header (reuses the old playbook code, so gap_plan_map and
      // re-seed stay idempotent).
      const planId = await upsert(
        'plan_templates',
        `insert into plan_templates (firm_id, source, code, name, summary, plan_version, status)
         values (null, 'system', $1, $2, $3, 1, 'active')
         on conflict (code, plan_version) where firm_id is null do update
           set name = excluded.name, summary = excluded.summary, status = 'active'
         returning id, (xmax = 0) as inserted`,
        [p.code, p.name, p.summary],
      );
      // Each system Plan is its own lineage root (firm Plans set this in createPlan).
      await db.query(`update plan_templates set lineage_id = id where id = $1 and lineage_id is null`, [planId]);
      recipePlanIdByPlaybook[p.code] = planId;
      let rSort = 0;
      for (const t of taskRefs) {
        await db.query(
          `insert into plan_template_items (firm_id, plan_template_id, item_kind, library_task_id, sort_order)
           values (null, $1, 'task', $2, $3)`,
          [planId, t.id, rSort++],
        );
        tally('plan_template_items', true);
      }
    }

    const contentIds: Record<string, string> = {};
    for (const c of contentModules) {
      contentIds[c.code] = await upsert(
        'content_modules',
        `insert into content_modules (code, title, dimension_code, body_md)
         values ($1, $2, $3, $4)
         on conflict (code) where firm_id is null do update
           set title = excluded.title, dimension_code = excluded.dimension_code,
               body_md = excluded.body_md
         returning id, (xmax = 0) as inserted`,
        [c.code, c.title, c.dimensionCode, c.body],
      );
    }

    // gap -> remediation Plan (the "roadmap initiative" a gap is linked to). The
    // seed map is authored gap -> playbook; each playbook is now a recipe Plan, so
    // resolve the playbook code to its Plan id.
    for (const m of gapPlaybookMap) {
      await upsert(
        'gap_plan_map',
        `insert into gap_plan_map (gap_definition_id, plan_template_id, priority)
         values ($1, $2, $3)
         on conflict (gap_definition_id, plan_template_id) do update set priority = excluded.priority
         returning id, (xmax = 0) as inserted`,
        [gapIds[m.fromCode], recipePlanIdByPlaybook[m.toCode], m.order],
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
    const advisoryIds: Record<string, string> = {};
    for (const a of advisoryItems) {
      advisoryIds[a.code] = await upsert(
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

    // Curated System Plans (docs/37): global methodology (firm_id null), keyed by
    // (code, plan_version). The header upserts idempotently; system items were
    // cleared up front and are rebuilt here. A 'playbook' seed item EXPANDS into
    // one 'task' item per library_task of that (former) playbook — the flatten
    // that removes the group-inside-a-group; every other kind maps one-to-one.
    for (const plan of SYSTEM_PLANS) {
      const planTemplateId = await upsert(
        'plan_templates',
        `insert into plan_templates (firm_id, source, code, name, summary, plan_version, status)
         values (null, 'system', $1, $2, $3, 1, 'active')
         on conflict (code, plan_version) where firm_id is null do update
           set name = excluded.name, summary = excluded.summary, status = 'active'
         returning id, (xmax = 0) as inserted`,
        [plan.code, plan.name, plan.summary],
      );
      await db.query(`update plan_templates set lineage_id = id where id = $1 and lineage_id is null`, [planTemplateId]);
      let sort = 0;
      for (const it of plan.items) {
        if (it.kind === 'playbook') {
          for (const t of libraryTasksByPlaybook[it.playbookCode!] ?? []) {
            await db.query(
              `insert into plan_template_items (firm_id, plan_template_id, item_kind, library_task_id, sort_order)
               values (null, $1, 'task', $2, $3)`,
              [planTemplateId, t.id, sort++],
            );
            tally('plan_template_items', true);
          }
          continue;
        }
        const contentId = it.kind === 'education' ? contentIds[it.contentModuleCode!] : null;
        const advisoryId = it.kind === 'advisory' ? advisoryIds[it.advisoryCode!] : null;
        await db.query(
          `insert into plan_template_items
             (firm_id, plan_template_id, item_kind, library_task_id, content_module_id,
              advisory_library_item_id, title, description, owner_role, track,
              target_offset_days, sort_order)
           values (null, $1, $2, null, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            planTemplateId, it.kind, contentId, advisoryId,
            it.title ?? null, it.description ?? null, it.ownerRole ?? null,
            it.track ?? null, it.targetOffsetDays ?? null, sort++,
          ],
        );
        tally('plan_template_items', true);
      }
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

    // Data Room template (docs/15 work stream B): global methodology, like the
    // rubric. Sections then items; items carry a soft gap_code (shared taxonomy).
    for (const s of dataRoomSections) {
      await upsert(
        'data_room_sections',
        `insert into data_room_sections (code, name, description, sort_order)
         values ($1, $2, $3, $4)
         on conflict (code) do update
           set name = excluded.name, description = excluded.description, sort_order = excluded.sort_order
         returning id, (xmax = 0) as inserted`,
        [s.code, s.name, s.description, s.sortOrder],
      );
    }
    for (const i of dataRoomItems) {
      await upsert(
        'data_room_items',
        `insert into data_room_items (section_code, code, label, description, buyer_rationale, applies_to, gap_code, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (code) do update
           set section_code = excluded.section_code, label = excluded.label,
               description = excluded.description, buyer_rationale = excluded.buyer_rationale,
               applies_to = excluded.applies_to, gap_code = excluded.gap_code,
               sort_order = excluded.sort_order
         returning id, (xmax = 0) as inserted`,
        [i.sectionCode, i.code, i.label, i.description, i.buyerRationale, i.appliesTo, i.gapCode, i.sortOrder],
      );
    }

    await db.query('commit');
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }

  // Verify end-state row counts against the seed files. Tables that also hold
  // tenant rows are counted with a filter so only the seeded (system) rows count.
  const expected: Record<string, number> = {
    rubric_versions: 1,
    dimensions: rubric.dimensions.length,
    questions: rubric.questions.length,
    sub_scores: rubric.subScores.length,
    gap_definitions: rubric.gapDefinitions.length,
    library_tasks: playbooks.reduce((n, p) => n + p.tasks.length, 0),
    content_modules: contentModules.length,
    gap_plan_map: gapPlaybookMap.length,
    gap_content_map: gapContentMap.length,
    advisory_library_items: advisoryItems.length,
    valuation_rules_versions: 1,
    valuation_multiples: valuationMultiples.length,
    data_room_sections: dataRoomSections.length,
    data_room_items: dataRoomItems.length,
    // One recipe Plan per (former) playbook + the curated System Plans.
    plan_templates: playbooks.length + SYSTEM_PLANS.length,
    // Recipe Plans carry one 'task' item per library_task; curated Plans expand
    // each 'playbook' seed item into that playbook's task items, others 1:1.
    plan_template_items:
      playbooks.reduce((n, p) => n + p.tasks.length, 0) +
      SYSTEM_PLANS.reduce(
        (n, plan) =>
          n +
          plan.items.reduce(
            (m, it) =>
              m +
              (it.kind === 'playbook'
                ? (playbooks.find((p) => p.code === it.playbookCode)?.tasks.length ?? 0)
                : 1),
            0,
          ),
        0,
      ),
  };
  const countFilter: Record<string, string> = {
    library_tasks: 'where firm_id is null',
    advisory_library_items: 'where firm_id is null',
    plan_templates: 'where firm_id is null',
    plan_template_items: 'where firm_id is null',
  };

  const rows: SeedTableReport[] = [];
  let ok = true;
  for (const [table, want] of Object.entries(expected)) {
    const { inserted = 0, updated = 0 } = report[table] ?? {};
    const total = Number(
      (await db.query(`select count(*)::int as c from ${table} ${countFilter[table] ?? ''}`)).rows[0].c,
    );
    const rowOk = total === want;
    if (!rowOk) ok = false;
    rows.push({ table, inserted, updated, total, expected: want, ok: rowOk });
  }

  // Tell PostgREST to reload its schema cache. In production, loading methodology
  // is a self-service, in-system step (the superadmin `seed-methodology` function
  // / "Load methodology" on /health) precisely so nobody runs the CLI against a
  // production connection string — but that also means the migrate.ts reload
  // (scripts/migrate.ts) may never run on the hosted DB when migrations are
  // applied out-of-band (Supabase CLI/dashboard). A methodology load introduces
  // brand-new tables (e.g. library_tasks, docs/37) that PostgREST doesn't know
  // about, so the app's REST reads 404 with "Could not find the table
  // 'public.<name>' in the schema cache". Signalling a reload here — over the
  // service-role connection, right after the write — keeps the REST API in sync
  // through the same self-service path. Best-effort: a stale cache must not
  // discard an otherwise-successful seed report. Harmless no-op on plain Postgres.
  await db.query("notify pgrst, 'reload schema'").catch(() => {});

  return { rows, ok };
}

// Migrate, load, validate, and write in one call. Applies any pending migrations
// FIRST (idempotent) so a schema-changing methodology update can be brought current
// entirely in-system: without this, seeding a brand-new table (e.g. library_tasks,
// docs/37) fails with `relation "..." does not exist` because "Load methodology"
// runs where the CLI `db:migrate` never did. Then loads + writes the seed; the
// write step signals the PostgREST schema-cache reload. Throws SeedValidationError
// (nothing written) on referential-integrity problems; returns the count report,
// annotated with any migrations applied, otherwise.
export async function seedMethodology(
  db: pg.ClientBase,
  opts: { seedDir?: string; migrationsDir?: string } = {},
): Promise<SeedResult> {
  const migrations = await applyMigrations(db, { migrationsDir: opts.migrationsDir });
  const bundle = loadSeedBundle(opts.seedDir ?? resolveSeedDir());
  const result = await writeSeedBundle(db, bundle);
  return { ...result, migrations };
}
