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
