// Proves firm isolation: a firm A advisor cannot read (or write into) firm B
// rows, and an owner only sees their own company's completed assessments.
// Runs everything in one transaction and rolls back — leaves no data behind.
// Usage: DATABASE_URL=... npm run test:rls
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query('begin');

  const asUser = async (userId: string | null) => {
    // Simulate a PostgREST request: authenticated role + JWT claims.
    await db.query('reset role');
    if (userId === null) {
      await db.query("select set_config('request.jwt.claims', '', true)");
    } else {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
    }
    await db.query('set local role authenticated');
  };
  const asSuper = async () => db.query('reset role');

  try {
    // Fixture data: two firms, an advisor in each, an owner in firm A.
    const ids = (
      await db.query(`
        with fa as (insert into firms (name) values ('Firm A') returning id),
             fb as (insert into firms (name) values ('Firm B') returning id),
             ua as (insert into auth.users (id, email) values (gen_random_uuid(), 'a@a.test') returning id),
             ub as (insert into auth.users (id, email) values (gen_random_uuid(), 'b@b.test') returning id),
             uo as (insert into auth.users (id, email) values (gen_random_uuid(), 'o@a.test') returning id)
        select (select id from fa) firm_a, (select id from fb) firm_b,
               (select id from ua) user_a, (select id from ub) user_b,
               (select id from uo) user_o`)
    ).rows[0];

    const companyA = (
      await db.query(
        `insert into companies (firm_id, name) values ($1, 'Alpha Co') returning id`,
        [ids.firm_a],
      )
    ).rows[0].id;
    const companyB = (
      await db.query(
        `insert into companies (firm_id, name) values ($1, 'Beta Co') returning id`,
        [ids.firm_b],
      )
    ).rows[0].id;

    await db.query(
      `insert into profiles (user_id, firm_id, role, full_name) values
         ($1, $2, 'advisor', 'Advisor A'), ($3, $4, 'advisor', 'Advisor B')`,
      [ids.user_a, ids.firm_a, ids.user_b, ids.firm_b],
    );
    await db.query(
      `insert into profiles (user_id, firm_id, role, company_id, full_name)
       values ($1, $2, 'owner', $3, 'Owner A')`,
      [ids.user_o, ids.firm_a, companyA],
    );

    const engagementA = (
      await db.query(
        `insert into engagements (firm_id, company_id) values ($1, $2) returning id`,
        [ids.firm_a, companyA],
      )
    ).rows[0].id;
    const engagementB = (
      await db.query(
        `insert into engagements (firm_id, company_id) values ($1, $2) returning id`,
        [ids.firm_b, companyB],
      )
    ).rows[0].id;

    const rubric = (
      await db.query(
        `insert into rubric_versions (version_label, status) values ('RLS-TEST', 'active') returning id`,
      )
    ).rows[0].id;
    await db.query(
      `insert into assessments (firm_id, engagement_id, rubric_version_id, status, sequence_number, completed_at)
       values ($1, $2, $3, 'completed', 1, now()), ($1, $2, $3, 'in_progress', 2, null)`,
      [ids.firm_a, engagementA, rubric],
    );
    await db.query(
      `insert into assessments (firm_id, engagement_id, rubric_version_id, status, sequence_number)
       values ($1, $2, $3, 'in_progress', 1)`,
      [ids.firm_b, engagementB, rubric],
    );
    await db.query(
      `insert into engagement_outcomes (firm_id, engagement_id, process_status)
       values ($1, $2, 'preparing'), ($3, $4, 'in_market')`,
      [ids.firm_a, engagementA, ids.firm_b, engagementB],
    );
    const eventA = (
      await db.query(
        `insert into outcome_events (firm_id, engagement_id, event_type, notes)
         values ($1, $2, 'ioi_received', 'firm A event') returning id`,
        [ids.firm_a, engagementA],
      )
    ).rows[0].id;
    await db.query(
      `insert into outcome_events (firm_id, engagement_id, event_type, notes)
       values ($1, $2, 'loi_received', 'firm B event')`,
      [ids.firm_b, engagementB],
    );
    await db.query(
      `insert into firm_branding (firm_id, display_name, accent_color)
       values ($1, 'Firm B Wealth', '#123456')`,
      [ids.firm_b],
    );
    await db.query(
      `insert into roadmap_milestones (firm_id, engagement_id, track, title)
       values ($1, $2, 'personal', 'Firm B milestone')`,
      [ids.firm_b, engagementB],
    );
    await db.query(
      `insert into advisory_library_items (firm_id, source, item_type, title, body, severity, score_trigger)
       values ($1, 'advisor', 'initiative', 'Firm B private play', 'secret', 'high', 70)`,
      [ids.firm_b],
    );
    // A global/system catalog row (rls-test runs before db:seed, so seed it here).
    await db.query(
      `insert into advisory_library_items (firm_id, source, item_type, code, title, body, severity, score_trigger)
       values (null, 'system', 'buyer_question', 'RLS-SYS-1', 'Global system question', 'shared', 'high', 70)`,
    );
    // A question + firm B provenance row for the answer_provenance isolation checks.
    const dimId = (
      await db.query(
        `insert into dimensions (rubric_version_id, code, name, score_group, drs_weight, sort_order)
         values ($1, 'RLSFIN', 'RLS Fin', 'business_readiness', 0, 99) returning id`,
        [rubric],
      )
    ).rows[0].id;
    const questionId = (
      await db.query(
        `insert into questions (dimension_id, code, prompt, answer_type, scored, sort_order)
         values ($1, 'RLS-Q1', 'q', 'numeric', true, 1) returning id`,
        [dimId],
      )
    ).rows[0].id;
    const assessmentBId = (
      await db.query(`select id from assessments where firm_id = $1 limit 1`, [ids.firm_b])
    ).rows[0].id;
    await db.query(
      `insert into answer_provenance (firm_id, assessment_id, question_id, source)
       values ($1, $2, $3, 'document')`,
      [ids.firm_b, assessmentBId, questionId],
    );
    // Firm B ledger connection + its OAuth secrets for the isolation checks.
    const ledgerB = (
      await db.query(
        `insert into ledger_connections (firm_id, company_id, provider, status, external_org_name)
         values ($1, $2, 'quickbooks', 'connected', 'Beta Books') returning id`,
        [ids.firm_b, companyB],
      )
    ).rows[0].id;
    await db.query(
      `insert into ledger_credentials (connection_id, access_token, refresh_token)
       values ($1, 'secret-access', 'secret-refresh')`,
      [ledgerB],
    );
    await db.query(
      `insert into ledger_oauth_states (state, firm_id, company_id, provider)
       values ('pending-b', $1, $2, 'quickbooks')`,
      [ids.firm_b, companyB],
    );
    // Firm B valuation recast + inputs for the isolation checks.
    await db.query(
      `insert into ebitda_recasts (firm_id, engagement_id, reported_ebitda) values ($1, $2, 900000)`,
      [ids.firm_b, engagementB],
    );
    await db.query(
      `insert into valuation_inputs (firm_id, engagement_id, owner_wealth_target) values ($1, $2, 4000000)`,
      [ids.firm_b, engagementB],
    );
    // A valuation rules version (rls-test runs before db:seed, so seed it here).
    await db.query(
      `insert into valuation_rules_versions (version_label, status) values ('RLS-VAL-1', 'active')`,
    );

    // --- Advisor A: sees firm A, not firm B -------------------------------
    console.log('advisor A (firm A):');
    await asUser(ids.user_a);
    const co = await db.query('select name from companies');
    check('sees exactly own firm companies', co.rows.length === 1 && co.rows[0].name === 'Alpha Co',
      `saw ${JSON.stringify(co.rows)}`);
    const eng = await db.query('select id from engagements');
    check('sees exactly own firm engagements', eng.rows.length === 1 && eng.rows[0].id === engagementA);
    const firmB = await db.query('select * from firms where id = $1', [ids.firm_b]);
    check('cannot read firm B row', firmB.rows.length === 0);
    const assessB = await db.query('select * from assessments where firm_id = $1', [ids.firm_b]);
    check('cannot read firm B assessments', assessB.rows.length === 0);
    let writeBlocked = false;
    try {
      await db.query('savepoint w');
      await db.query(`insert into companies (firm_id, name) values ($1, 'Sneaky Co')`, [ids.firm_b]);
      await db.query('release savepoint w');
    } catch {
      writeBlocked = true;
      await db.query('rollback to savepoint w');
    }
    check('cannot insert a company into firm B', writeBlocked);
    const rubricRead = await db.query('select count(*)::int c from rubric_versions');
    check('can read methodology tables', rubricRead.rows[0].c >= 1);
    const outcomesA = await db.query('select engagement_id from engagement_outcomes');
    check('sees only own firm engagement_outcomes',
      outcomesA.rows.length === 1 && outcomesA.rows[0].engagement_id === engagementA);
    const eventsA = await db.query('select notes from outcome_events');
    check('sees only own firm outcome_events',
      eventsA.rows.length === 1 && eventsA.rows[0].notes === 'firm A event');
    await db.query(
      `insert into outcome_events (firm_id, engagement_id, event_type, notes)
       values ($1, $2, 'qoe_started', 'appended by advisor A')`,
      [ids.firm_a, engagementA],
    );
    check('can append outcome_events for own firm', true);
    let eventUpdateBlocked = false;
    try {
      await db.query('savepoint oe');
      const upd = await db.query(`update outcome_events set notes = 'tampered' where id = $1`, [eventA]);
      eventUpdateBlocked = upd.rowCount === 0;
      await db.query('release savepoint oe');
    } catch {
      eventUpdateBlocked = true;
      await db.query('rollback to savepoint oe');
    }
    check('cannot update outcome_events (append-only)', eventUpdateBlocked);
    let eventDeleteBlocked = false;
    try {
      await db.query('savepoint oe2');
      const del = await db.query(`delete from outcome_events where id = $1`, [eventA]);
      eventDeleteBlocked = del.rowCount === 0;
      await db.query('release savepoint oe2');
    } catch {
      eventDeleteBlocked = true;
      await db.query('rollback to savepoint oe2');
    }
    check('cannot delete outcome_events (append-only)', eventDeleteBlocked);

    // firm_branding: advisor A writes+reads own firm, never sees firm B
    await db.query(
      `insert into firm_branding (firm_id, display_name, accent_color)
       values ($1, 'Firm A Advisory', '#1f7a52')`,
      [ids.firm_a],
    );
    check('can create own firm branding', true);
    const brandingA = await db.query('select display_name from firm_branding');
    check(
      'sees only own firm branding',
      brandingA.rows.length === 1 && brandingA.rows[0].display_name === 'Firm A Advisory',
      `saw ${JSON.stringify(brandingA.rows)}`,
    );
    let brandBWriteBlocked = false;
    try {
      await db.query('savepoint bb');
      const upd = await db.query(
        `update firm_branding set display_name = 'hijacked' where firm_id = $1`,
        [ids.firm_b],
      );
      brandBWriteBlocked = upd.rowCount === 0;
      await db.query('release savepoint bb');
    } catch {
      brandBWriteBlocked = true;
      await db.query('rollback to savepoint bb');
    }
    check('cannot modify firm B branding', brandBWriteBlocked);

    // roadmap_milestones: advisor A writes+reads own firm, never sees firm B
    await db.query(
      `insert into roadmap_milestones (firm_id, engagement_id, track, title)
       values ($1, $2, 'business', 'Firm A milestone')`,
      [ids.firm_a, engagementA],
    );
    check('can create own firm milestone', true);
    const milestonesA = await db.query('select title from roadmap_milestones');
    check(
      'sees only own firm milestones',
      milestonesA.rows.length === 1 && milestonesA.rows[0].title === 'Firm A milestone',
      `saw ${JSON.stringify(milestonesA.rows)}`,
    );

    // advisory_library: advisor A reads global (system) items + own firm items,
    // never firm B's advisor-authored items; can create own, cannot create for B.
    await db.query(
      `insert into advisory_library_items (firm_id, source, item_type, title, body, severity, score_trigger)
       values ($1, 'advisor', 'buyer_question', 'Firm A private question', 'ours', 'high', 70)`,
      [ids.firm_a],
    );
    check('can create own firm advisory item', true);
    const libA = await db.query(
      `select firm_id, title from advisory_library_items order by title`,
    );
    const systemVisible = libA.rows.filter((r) => r.firm_id === null).length;
    const firmVisible = libA.rows.filter((r) => r.firm_id === ids.firm_a).length;
    const foreignVisible = libA.rows.filter((r) => r.firm_id === ids.firm_b).length;
    check('reads the global system catalog', systemVisible >= 1, `saw ${systemVisible} system rows`);
    check('sees own firm advisory items', firmVisible === 1, `saw ${firmVisible} own rows`);
    check('cannot read firm B advisory items', foreignVisible === 0, `saw ${foreignVisible} firm B rows`);
    let libBWriteBlocked = false;
    try {
      await db.query('savepoint lib');
      await db.query(
        `insert into advisory_library_items (firm_id, source, item_type, title, body)
         values ($1, 'advisor', 'initiative', 'sneak', 'x')`,
        [ids.firm_b],
      );
      await db.query('release savepoint lib');
    } catch {
      libBWriteBlocked = true;
      await db.query('rollback to savepoint lib');
    }
    check('cannot create advisory item for firm B', libBWriteBlocked);
    let sysWriteBlocked = false;
    try {
      await db.query('savepoint sys');
      await db.query(
        `insert into advisory_library_items (firm_id, source, item_type, title, body)
         values (null, 'system', 'initiative', 'fake system', 'x')`,
      );
      await db.query('release savepoint sys');
    } catch {
      sysWriteBlocked = true;
      await db.query('rollback to savepoint sys');
    }
    check('cannot write into the global system catalog', sysWriteBlocked);

    // answer_provenance: advisor A reads/writes only their firm's rows.
    const provA = await db.query('select firm_id from answer_provenance');
    check(
      'cannot read firm B provenance',
      provA.rows.every((r) => r.firm_id !== ids.firm_b),
      `saw ${provA.rows.filter((r) => r.firm_id === ids.firm_b).length} firm B rows`,
    );
    let provBWriteBlocked = false;
    try {
      await db.query('savepoint prov');
      await db.query(
        `insert into answer_provenance (firm_id, assessment_id, question_id, source)
         values ($1, $2, $3, 'document')`,
        [ids.firm_b, assessmentBId, questionId],
      );
      await db.query('release savepoint prov');
    } catch {
      provBWriteBlocked = true;
      await db.query('rollback to savepoint prov');
    }
    check('cannot write provenance for firm B', provBWriteBlocked);

    // ledger_connections: advisor A reads/writes only their firm's rows.
    const ledgerA = await db.query('select firm_id from ledger_connections');
    check(
      'cannot read firm B ledger connection',
      ledgerA.rows.every((r) => r.firm_id !== ids.firm_b),
      `saw ${ledgerA.rows.filter((r) => r.firm_id === ids.firm_b).length} firm B rows`,
    );
    // OAuth tokens are quarantined: no client role can even select the table.
    for (const secret of ['ledger_credentials', 'ledger_oauth_states']) {
      let denied = false;
      try {
        await db.query('savepoint sec');
        await db.query(`select * from ${secret}`);
        await db.query('release savepoint sec');
      } catch {
        denied = true;
        await db.query('rollback to savepoint sec');
      }
      check(`cannot read ${secret} (tokens quarantined from clients)`, denied);
    }

    // valuation: methodology readable; firm B recast/inputs never visible.
    const valRules = await db.query('select count(*)::int c from valuation_rules_versions');
    check('can read valuation methodology', valRules.rows[0].c >= 1);
    const recastA = await db.query('select firm_id from ebitda_recasts');
    check(
      'cannot read firm B recast',
      recastA.rows.every((r) => r.firm_id !== ids.firm_b),
      `saw ${recastA.rows.filter((r) => r.firm_id === ids.firm_b).length} firm B rows`,
    );
    const valInA = await db.query('select firm_id from valuation_inputs');
    check(
      'cannot read firm B valuation inputs',
      valInA.rows.every((r) => r.firm_id !== ids.firm_b),
      `saw ${valInA.rows.filter((r) => r.firm_id === ids.firm_b).length} firm B rows`,
    );

    // --- Advisor B: mirror check ------------------------------------------
    console.log('advisor B (firm B):');
    await asUser(ids.user_b);
    const coB = await db.query('select name from companies');
    check('sees exactly own firm companies', coB.rows.length === 1 && coB.rows[0].name === 'Beta Co',
      `saw ${JSON.stringify(coB.rows)}`);

    // --- Owner A: own company, completed assessments only ------------------
    console.log('owner (firm A company):');
    await asUser(ids.user_o);
    const coO = await db.query('select name from companies');
    check('sees only their company', coO.rows.length === 1 && coO.rows[0].name === 'Alpha Co');
    const assessO = await db.query('select status from assessments');
    check('sees only completed assessments', assessO.rows.length === 1 && assessO.rows[0].status === 'completed',
      `saw ${JSON.stringify(assessO.rows)}`);
    let ownerWriteBlocked = false;
    try {
      await db.query('savepoint w2');
      await db.query(`update companies set name = 'Renamed' where id = $1`, [companyA]);
      const renamed = await db.query('select name from companies where id = $1', [companyA]);
      ownerWriteBlocked = renamed.rows[0]?.name !== 'Renamed';
      await db.query('release savepoint w2');
    } catch {
      ownerWriteBlocked = true;
      await db.query('rollback to savepoint w2');
    }
    check('cannot write (read-only role)', ownerWriteBlocked);
    const ownerBranding = await db.query('select display_name from firm_branding');
    check(
      'owner reads only their firm branding',
      ownerBranding.rows.length === 1 && ownerBranding.rows[0].display_name === 'Firm A Advisory',
      `saw ${JSON.stringify(ownerBranding.rows)}`,
    );
    let ownerBrandWriteBlocked = false;
    try {
      await db.query('savepoint ob');
      const upd = await db.query(
        `update firm_branding set display_name = 'owner-edit' where firm_id = $1`,
        [ids.firm_a],
      );
      ownerBrandWriteBlocked = upd.rowCount === 0;
      await db.query('release savepoint ob');
    } catch {
      ownerBrandWriteBlocked = true;
      await db.query('rollback to savepoint ob');
    }
    check('owner cannot write branding', ownerBrandWriteBlocked);
    const ownerMilestones = await db.query('select title from roadmap_milestones');
    check(
      'owner reads only their firm milestones',
      ownerMilestones.rows.length === 1 && ownerMilestones.rows[0].title === 'Firm A milestone',
      `saw ${JSON.stringify(ownerMilestones.rows)}`,
    );
    let ownerMilestoneWriteBlocked = false;
    try {
      await db.query('savepoint om');
      const upd = await db.query(
        `update roadmap_milestones set title = 'owner-edit' where firm_id = $1`,
        [ids.firm_a],
      );
      ownerMilestoneWriteBlocked = upd.rowCount === 0;
      await db.query('release savepoint om');
    } catch {
      ownerMilestoneWriteBlocked = true;
      await db.query('rollback to savepoint om');
    }
    check('owner cannot write milestones', ownerMilestoneWriteBlocked);
    // Owner can connect their own company's ledger, and never sees firm B's.
    let ownerLedgerWrite = false;
    try {
      await db.query('savepoint ol');
      await db.query(
        `insert into ledger_connections (firm_id, company_id, provider, status, external_org_name)
         values ($1, $2, 'xero', 'connected', 'Alpha Books')`,
        [ids.firm_a, companyA],
      );
      ownerLedgerWrite = true;
      await db.query('release savepoint ol');
    } catch {
      await db.query('rollback to savepoint ol');
    }
    check('owner can connect own company ledger', ownerLedgerWrite);
    const ownerLedger = await db.query('select firm_id from ledger_connections');
    check(
      'owner cannot read firm B ledger connection',
      ownerLedger.rows.every((r) => r.firm_id !== ids.firm_b),
      `saw ${ownerLedger.rows.filter((r) => r.firm_id === ids.firm_b).length} firm B rows`,
    );
    // Owner reads their own number but never another firm's valuation.
    const ownerRecast = await db.query('select firm_id from ebitda_recasts');
    check(
      'owner cannot read firm B recast',
      ownerRecast.rows.every((r) => r.firm_id !== ids.firm_b),
      `saw ${ownerRecast.rows.filter((r) => r.firm_id === ids.firm_b).length} firm B rows`,
    );

    // Owner never sees another firm's financial provenance.
    const ownerProv = await db.query('select firm_id from answer_provenance');
    check(
      'owner cannot read firm B provenance',
      ownerProv.rows.every((r) => r.firm_id !== ids.firm_b),
      `saw ${ownerProv.rows.filter((r) => r.firm_id === ids.firm_b).length} firm B rows`,
    );
    // Owner reads the global catalog but no firm-scoped advisor items (advisor-only policy).
    const ownerLib = await db.query('select firm_id from advisory_library_items');
    check(
      'owner reads only the global advisory catalog',
      ownerLib.rows.length >= 1 && ownerLib.rows.every((r) => r.firm_id === null),
      `saw ${ownerLib.rows.length} rows, ${ownerLib.rows.filter((r) => r.firm_id !== null).length} firm-scoped`,
    );

    // --- Unauthenticated: nothing ------------------------------------------
    console.log('unauthenticated:');
    await asUser(null);
    const coAnon = await db.query('select count(*)::int c from companies');
    check('sees no companies', coAnon.rows[0].c === 0);
  } finally {
    await asSuper();
    await db.query('rollback');
    await db.end();
  }

  console.log(`\nRLS test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
