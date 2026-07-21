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
    // Simulate a request under Clerk third-party auth: authenticated role + a JWT
    // claim set whose `sub` is a Clerk user id (text). RLS resolves identity via
    // auth.jwt() ->> 'sub' (see 20260719000100_clerk_identity.sql).
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
    // Identity is Clerk now: profiles.user_id holds a Clerk user id (text), no
    // auth.users FK. Mint Clerk-shaped subjects directly.
    const ids = (
      await db.query(`
        with fa as (insert into firms (name) values ('Firm A') returning id),
             fb as (insert into firms (name) values ('Firm B') returning id)
        select (select id from fa) firm_a, (select id from fb) firm_b,
               'user_clerk_a' user_a, 'user_clerk_b' user_b, 'user_clerk_o' user_o,
               'user_clerk_adm' user_adm, 'user_clerk_c' user_c`)
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
         ($1, $2, 'advisor', 'Advisor A'), ($3, $4, 'advisor', 'Advisor B'),
         ($5, $2, 'admin', 'Admin A')`,
      [ids.user_a, ids.firm_a, ids.user_b, ids.firm_b, ids.user_adm],
    );
    await db.query(
      `insert into profiles (user_id, firm_id, role, company_id, full_name)
       values ($1, $2, 'owner', $3, 'Owner A')`,
      [ids.user_o, ids.firm_a, companyA],
    );

    // Billing: a subscription per firm (the webhook/service-role writes these).
    await db.query(
      `insert into firm_subscriptions (firm_id, plan_code, status, seats) values
         ($1, 'practice', 'active', 5), ($2, 'solo', 'active', 1)`,
      [ids.firm_a, ids.firm_b],
    );
    // An internal webhook log row — must never be readable by an authenticated user.
    await db.query(
      `insert into billing_events (stripe_event_id, type) values ('evt_test_1', 'invoice.paid')`,
    );

    const engagementA = (
      await db.query(
        `insert into engagements (firm_id, company_id) values ($1, $2) returning id`,
        [ids.firm_a, companyA],
      )
    ).rows[0].id;
    // A SECOND engagement in company A — used to prove a view-only collaborator
    // scoped to engagementA sees ONLY that engagement, never a sibling engagement
    // of the same company (per-engagement isolation, stronger than the owner's
    // per-company scope).
    const engagementA2 = (
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

    // Beta R1: engagements need an accepted agreement before assessments can be
    // created (gate trigger). Version per firm + an acceptance per engagement.
    const agreementA = (
      await db.query(
        `insert into agreement_versions (firm_id, version_label, title, body_md)
         values ($1, 'EA-A', 'Firm A EA', 'firm A body') returning id`,
        [ids.firm_a],
      )
    ).rows[0].id;
    const agreementB = (
      await db.query(
        `insert into agreement_versions (firm_id, version_label, title, body_md)
         values ($1, 'EA-B', 'Firm B EA', 'firm B body') returning id`,
        [ids.firm_b],
      )
    ).rows[0].id;
    await db.query(
      `insert into engagement_agreements (firm_id, engagement_id, agreement_version_id)
       values ($1, $2, $3), ($4, $5, $6)`,
      [ids.firm_a, engagementA, agreementA, ids.firm_b, engagementB, agreementB],
    );

    // A view-only external collaborator (e.g. the client's CPA) scoped to
    // engagementA only — carries firm_id + company_id + engagement_id — plus its
    // roster row. Created here now that engagementA exists.
    await db.query(
      `insert into profiles (user_id, firm_id, role, company_id, engagement_id, full_name)
       values ($1, $2, 'collaborator', $3, $4, 'CPA A')`,
      [ids.user_c, ids.firm_a, companyA, engagementA],
    );
    await db.query(
      `insert into engagement_collaborators (firm_id, engagement_id, company_id, email, kind, status, user_id)
       values ($1, $2, $3, 'cpa@a.co', 'cpa', 'active', $4)`,
      [ids.firm_a, engagementA, companyA, ids.user_c],
    );

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
    // Plans (docs/37): a global/system template, a firm B firm-authored template,
    // and a firm B applied plan — for the plan-isolation checks below.
    await db.query(
      `insert into plan_templates (firm_id, source, code, name, plan_version, status)
       values (null, 'system', 'RLS-SYS-PLAN', 'Global system plan', 1, 'active')`,
    );
    const firmBPlanTemplate = (
      await db.query(
        `insert into plan_templates (firm_id, source, name, status)
         values ($1, 'advisor', 'Firm B private plan', 'active') returning id`,
        [ids.firm_b],
      )
    ).rows[0].id;
    await db.query(
      `insert into engagement_plans (firm_id, engagement_id, plan_template_id, applied_plan_version, name)
       values ($1, $2, $3, 1, 'Firm B applied plan')`,
      [ids.firm_b, engagementB, firmBPlanTemplate],
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
    // Immutability fixtures: Firm A's completed assessment plus one scored child
    // of each kind, so the freeze triggers (migration 20260718000200) have real
    // rows to guard. Inserted while completed — inserts are never frozen.
    const assessmentACompleted = (
      await db.query(
        `select id from assessments where firm_id = $1 and status = 'completed' limit 1`,
        [ids.firm_a],
      )
    ).rows[0].id;
    const subScoreId = (
      await db.query(
        `insert into sub_scores (dimension_id, code, name, weight, formula_type, input_question_codes)
         values ($1, 'RLS-SS1', 'RLS Sub', 1, 'band_gte', 'RLS-Q1') returning id`,
        [dimId],
      )
    ).rows[0].id;
    await db.query(
      `insert into answers (assessment_id, question_id, value) values ($1, $2, '1'::jsonb)`,
      [assessmentACompleted, questionId],
    );
    await db.query(
      `insert into sub_score_results (assessment_id, sub_score_id, points) values ($1, $2, 1)`,
      [assessmentACompleted, subScoreId],
    );
    await db.query(
      `insert into dimension_scores (assessment_id, dimension_id, score) values ($1, $2, 1)`,
      [assessmentACompleted, dimId],
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
    // A Data Room template row (also seeded here, since rls-test precedes db:seed)
    // so the firm-scoped engagement_data_room_items FK resolves.
    await db.query(`insert into data_room_sections (code, name) values ('FIN', 'Financial')`);
    await db.query(
      `insert into data_room_items (section_code, code, label) values ('FIN', 'FIN-STMTS', 'Statements')`,
    );
    await db.query(
      `insert into engagement_data_room_items (firm_id, engagement_id, item_code, readiness_state)
       values ($1, $2, 'FIN-STMTS', 'ready')`,
      [ids.firm_b, engagementB],
    );
    // Firm B engagement-log entry for the institutional-memory isolation checks.
    await db.query(
      `insert into engagement_log (firm_id, engagement_id, kind, title) values ($1, $2, 'decision', 'Secret rationale')`,
      [ids.firm_b, engagementB],
    );
    // Firm B document + extracted field for the R3 isolation checks.
    const documentB = (
      await db.query(
        `insert into documents (firm_id, engagement_id, original_filename, mime_type, status)
         values ($1, $2, 'firmB.pdf', 'application/pdf', 'in_review') returning id`,
        [ids.firm_b, engagementB],
      )
    ).rows[0].id;
    await db.query(
      `insert into document_fields (firm_id, document_id, field_key, value, verification_status)
       values ($1, $2, 'Secret EBITDA', '999', 'extracted')`,
      [ids.firm_b, documentB],
    );
    // Firm B sell-side intelligence rows for the isolation checks.
    await db.query(
      `insert into graph_nodes (firm_id, engagement_id, node_type, attributes)
       values ($1, $2, 'Company', '{"name":"Secret Co"}'::jsonb)`,
      [ids.firm_b, engagementB],
    );
    await db.query(
      `insert into assessment_values (firm_id, engagement_id, field_key, source)
       values ($1, $2, 'annual_revenue', 'document_verified')`,
      [ids.firm_b, engagementB],
    );
    await db.query(
      `insert into findings (firm_id, engagement_id, pattern_key, severity)
       values ($1, $2, 'customer_concentration', 'high')`,
      [ids.firm_b, engagementB],
    );
    await db.query(
      `insert into jobs (firm_id, engagement_id, pipeline, step) values ($1, $2, 'sellside_intake', 'intake')`,
      [ids.firm_b, engagementB],
    );
    await db.query(
      `insert into review_items (firm_id, engagement_id, type) values ($1, $2, 'conflict')`,
      [ids.firm_b, engagementB],
    );
    await db.query(
      `insert into llm_calls (firm_id, engagement_id, prompt_key, model)
       values ($1, $2, 'extract.financials.v1', 'claude-opus-4-8')`,
      [ids.firm_b, engagementB],
    );
    // Firm B audit-log + usage-event rows for the R5/R6 isolation checks.
    await db.query(
      `insert into data_access_log (firm_id, action, resource_type, resource_id)
       values ($1, 'document.read', 'document', $2)`,
      [ids.firm_b, documentB],
    );
    await db.query(
      `insert into usage_events (firm_id, event_type, event_name) values ($1, 'report', 'report_downloaded')`,
      [ids.firm_b],
    );

    // --- Advisor A: sees firm A, not firm B -------------------------------
    console.log('advisor A (firm A):');
    await asUser(ids.user_a);
    const co = await db.query('select name from companies');
    check('sees exactly own firm companies', co.rows.length === 1 && co.rows[0].name === 'Alpha Co',
      `saw ${JSON.stringify(co.rows)}`);
    const eng = await db.query('select id from engagements');
    check('sees exactly own firm engagements',
      eng.rows.length === 2 && eng.rows.every((r) => r.id === engagementA || r.id === engagementA2),
      `saw ${JSON.stringify(eng.rows)}`);
    const firmB = await db.query('select * from firms where id = $1', [ids.firm_b]);
    check('cannot read firm B row', firmB.rows.length === 0);
    const assessB = await db.query('select * from assessments where firm_id = $1', [ids.firm_b]);
    check('cannot read firm B assessments', assessB.rows.length === 0);
    // Billing isolation.
    const subs = await db.query('select firm_id, plan_code from firm_subscriptions');
    check('reads only own firm subscription',
      subs.rows.length === 1 && subs.rows[0].firm_id === ids.firm_a && subs.rows[0].plan_code === 'practice',
      `saw ${JSON.stringify(subs.rows)}`);
    const plansRead = await db.query('select count(*)::int c from plans');
    check('reads the plan catalog', plansRead.rows[0].c >= 3, `saw ${plansRead.rows[0].c}`);
    // billing_events has no grant to authenticated at all — a read is a hard
    // permission error, not just an empty RLS result. Assert it throws.
    let billingEventsDenied = false;
    try {
      await db.query('savepoint be');
      await db.query('select count(*) from billing_events');
      await db.query('release savepoint be');
    } catch {
      billingEventsDenied = true;
      await db.query('rollback to savepoint be');
    }
    check('cannot read billing_events (service-role only)', billingEventsDenied);
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

    // Completed-assessment immutability (migration 20260718000200; docs/archive/23).
    // Advisor A holds role `authenticated` here (asUser), the untrusted path the
    // freeze triggers constrain: a completed snapshot and its scored children
    // cannot be altered or deleted through an end-user JWT — not the score, not
    // the answers, and not even the supersede bookkeeping (corrections are
    // orchestrated server-side as service_role, never by a client write). Each
    // attempt runs in its own savepoint since the trigger RAISEs (aborting to
    // that savepoint).
    const expectFrozen = async (label: string, sql: string, params: unknown[]) => {
      let blocked = false;
      try {
        await db.query(`savepoint imm`);
        await db.query(sql, params);
        await db.query(`rollback to savepoint imm`); // succeeded (wrongly) — undo
      } catch {
        blocked = true;
        await db.query(`rollback to savepoint imm`);
      }
      check(label, blocked);
    };
    await expectFrozen(
      'cannot edit the score of a completed assessment',
      `update assessments set drs_score = 1 where id = $1`, [assessmentACompleted]);
    await expectFrozen(
      'cannot delete a completed assessment',
      `delete from assessments where id = $1`, [assessmentACompleted]);
    await expectFrozen(
      "cannot edit a completed assessment's sub_score_results",
      `update sub_score_results set points = 0 where assessment_id = $1`, [assessmentACompleted]);
    await expectFrozen(
      "cannot delete a completed assessment's dimension_scores",
      `delete from dimension_scores where assessment_id = $1`, [assessmentACompleted]);
    await expectFrozen(
      "cannot delete a completed assessment's answers",
      `delete from answers where assessment_id = $1`, [assessmentACompleted]);
    await expectFrozen(
      'cannot supersede a completed assessment via a client write (server-side only)',
      `update assessments set record_status = 'superseded', supersede_reason = 'rls-test' where id = $1`,
      [assessmentACompleted]);

    // agreement_versions + engagement_agreements: firm isolation (beta R1)
    const avA = await db.query('select version_label from agreement_versions');
    check('sees only own firm agreement_versions',
      avA.rows.length === 1 && avA.rows[0].version_label === 'EA-A', `saw ${JSON.stringify(avA.rows)}`);
    const eaA = await db.query('select engagement_id from engagement_agreements');
    check('sees only own firm engagement_agreements',
      eaA.rows.length === 1 && eaA.rows[0].engagement_id === engagementA);
    let avBWriteBlocked = false;
    try {
      await db.query('savepoint av');
      const ins = await db.query(
        `insert into agreement_versions (firm_id, version_label, title, body_md)
         values ($1, 'SNEAK', 't', 'b')`,
        [ids.firm_b],
      );
      avBWriteBlocked = ins.rowCount === 0;
      await db.query('release savepoint av');
    } catch {
      avBWriteBlocked = true;
      await db.query('rollback to savepoint av');
    }
    check('cannot insert an agreement_version into firm B', avBWriteBlocked);

    // Gate: an assessment cannot be created for an engagement with no accepted
    // agreement (beta acceptance criterion 1 — no assessment data before consent).
    await asSuper();
    await db.query('savepoint gate');
    let gateBlocked = false;
    try {
      const ge = (
        await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [
          ids.firm_a,
          companyA,
        ])
      ).rows[0].id;
      await db.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, status, sequence_number)
         values ($1, $2, $3, 'in_progress', 1)`,
        [ids.firm_a, ge, rubric],
      );
    } catch {
      gateBlocked = true;
    }
    await db.query('rollback to savepoint gate');
    check('assessment blocked for engagement without agreement acceptance', gateBlocked);
    await asUser(ids.user_a);

    // documents + document_fields: firm isolation (beta R3)
    const docsA = await db.query('select id from documents');
    check('sees no firm B documents', docsA.rows.length === 0, `saw ${docsA.rows.length}`);
    const dfA = await db.query('select value from document_fields');
    check('sees no firm B document_fields', dfA.rows.length === 0, `saw ${dfA.rows.length}`);
    let docBWriteBlocked = false;
    try {
      await db.query('savepoint doc');
      const ins = await db.query(
        `insert into documents (firm_id, engagement_id, original_filename, mime_type, status)
         values ($1, $2, 'sneak.pdf', 'application/pdf', 'in_review')`,
        [ids.firm_b, engagementB],
      );
      docBWriteBlocked = ins.rowCount === 0;
      await db.query('release savepoint doc');
    } catch {
      docBWriteBlocked = true;
      await db.query('rollback to savepoint doc');
    }
    check('cannot insert a document into firm B', docBWriteBlocked);

    // Data Room readiness: firm isolation. Template is global (readable), but the
    // per-engagement states are firm-scoped tenant data.
    const drTemplate = await db.query('select code from data_room_items');
    check('reads the global data room template', drTemplate.rows.length >= 1);
    const drA = await db.query('select id from engagement_data_room_items');
    check('sees no firm B data room states', drA.rows.length === 0, `saw ${drA.rows.length}`);
    let drBWriteBlocked = false;
    try {
      await db.query('savepoint dr');
      const ins = await db.query(
        `insert into engagement_data_room_items (firm_id, engagement_id, item_code, readiness_state)
         values ($1, $2, 'FIN-STMTS', 'gap')`,
        [ids.firm_b, engagementB],
      );
      drBWriteBlocked = ins.rowCount === 0;
      await db.query('release savepoint dr');
    } catch {
      drBWriteBlocked = true;
      await db.query('rollback to savepoint dr');
    }
    check('cannot insert a data room state into firm B', drBWriteBlocked);
    const drOwnWrite = await db.query(
      `insert into engagement_data_room_items (firm_id, engagement_id, item_code, readiness_state)
       values ($1, $2, 'FIN-STMTS', 'ready') returning id`,
      [ids.firm_a, engagementA],
    );
    check('can set own firm data room state', drOwnWrite.rowCount === 1);

    // Engagement log (institutional memory): firm isolation, staff-only.
    const elogA = await db.query('select id from engagement_log');
    check('sees no firm B engagement log', elogA.rows.length === 0, `saw ${elogA.rows.length}`);
    const logOwnWrite = await db.query(
      `insert into engagement_log (firm_id, engagement_id, kind, title) values ($1, $2, 'meeting', 'Kickoff') returning id`,
      [ids.firm_a, engagementA],
    );
    check('can write own firm engagement log', logOwnWrite.rowCount === 1);
    let logBWriteBlocked = false;
    try {
      await db.query('savepoint elog');
      const ins = await db.query(
        `insert into engagement_log (firm_id, engagement_id, kind, title) values ($1, $2, 'note', 'sneak')`,
        [ids.firm_b, engagementB],
      );
      logBWriteBlocked = ins.rowCount === 0;
      await db.query('release savepoint elog');
    } catch {
      logBWriteBlocked = true;
      await db.query('rollback to savepoint elog');
    }
    check('cannot insert an engagement log entry into firm B', logBWriteBlocked);

    // Sell-side intelligence substrate: firm isolation (graph, reconciliation,
    // findings, jobs, review queue, LLM cost ledger).
    check('sees no firm B graph_nodes', (await db.query('select id from graph_nodes')).rows.length === 0);
    check(
      'sees no firm B assessment_values',
      (await db.query('select id from assessment_values')).rows.length === 0,
    );
    check('sees no firm B findings', (await db.query('select id from findings')).rows.length === 0);
    check('sees no firm B jobs', (await db.query('select id from jobs')).rows.length === 0);
    check('sees no firm B review_items', (await db.query('select id from review_items')).rows.length === 0);
    check('sees no firm B llm_calls', (await db.query('select id from llm_calls')).rows.length === 0);
    let graphBWriteBlocked = false;
    try {
      await db.query('savepoint gn');
      const ins = await db.query(
        `insert into graph_nodes (firm_id, engagement_id, node_type) values ($1, $2, 'Company')`,
        [ids.firm_b, engagementB],
      );
      graphBWriteBlocked = ins.rowCount === 0;
      await db.query('release savepoint gn');
    } catch {
      graphBWriteBlocked = true;
      await db.query('rollback to savepoint gn');
    }
    check('cannot insert a graph_node into firm B', graphBWriteBlocked);

    // data_access_log + usage_events: firm isolation (beta R5/R6)
    const logA = await db.query('select id from data_access_log');
    check('sees no firm B data_access_log', logA.rows.length === 0, `saw ${logA.rows.length}`);
    const ueA = await db.query('select event_name from usage_events');
    check('sees no firm B usage_events', ueA.rows.length === 0, `saw ${ueA.rows.length}`);
    // Advisor A can emit a usage event for their own firm (RLS insert check).
    let ueInsertOk = false;
    try {
      await db.query('savepoint ue');
      const ins = await db.query(
        `insert into usage_events (firm_id, event_type, event_name) values ($1, 'onboarding', 'engagement_started')`,
        [ids.firm_a],
      );
      ueInsertOk = (ins.rowCount ?? 0) === 1;
      await db.query('release savepoint ue');
    } catch {
      await db.query('rollback to savepoint ue');
    }
    check('can emit a usage_event for own firm', ueInsertOk);

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

    // plan_templates (docs/37): advisor A reads global system plans + own firm,
    // never firm B's; can create own, cannot create for B or write a system row.
    await db.query(
      `insert into plan_templates (firm_id, source, name, status)
       values ($1, 'advisor', 'Firm A plan', 'active')`,
      [ids.firm_a],
    );
    check('can create own firm plan template', true);
    const plansA = await db.query('select firm_id, name from plan_templates order by name');
    check(
      'reads the global system plan template',
      plansA.rows.filter((r) => r.firm_id === null).length >= 1,
      `saw ${plansA.rows.filter((r) => r.firm_id === null).length} system plans`,
    );
    check(
      'sees own firm plan templates',
      plansA.rows.filter((r) => r.firm_id === ids.firm_a).length === 1,
    );
    check(
      'cannot read firm B plan templates',
      plansA.rows.filter((r) => r.firm_id === ids.firm_b).length === 0,
    );
    let planBWriteBlocked = false;
    try {
      await db.query('savepoint plan');
      await db.query(
        `insert into plan_templates (firm_id, source, name) values ($1, 'advisor', 'sneak')`,
        [ids.firm_b],
      );
      await db.query('release savepoint plan');
    } catch {
      planBWriteBlocked = true;
      await db.query('rollback to savepoint plan');
    }
    check('cannot create plan template for firm B', planBWriteBlocked);
    let planSysWriteBlocked = false;
    try {
      await db.query('savepoint plansys');
      await db.query(
        `insert into plan_templates (firm_id, source, name) values (null, 'system', 'fake system plan')`,
      );
      await db.query('release savepoint plansys');
    } catch {
      planSysWriteBlocked = true;
      await db.query('rollback to savepoint plansys');
    }
    check('cannot write into the global system plan catalog', planSysWriteBlocked);

    // engagement_plans (applied instances): advisor A applies to own engagement,
    // sees only own firm's applied plans, never firm B's.
    const appliedA = await db.query(
      `insert into engagement_plans (firm_id, engagement_id, plan_template_id, applied_plan_version, name)
       select $1, $2, id, 1, 'Firm A applied plan' from plan_templates where firm_id = $1 limit 1
       returning id`,
      [ids.firm_a, engagementA],
    );
    check('can apply a plan to own firm engagement', appliedA.rows.length === 1);
    const appliedAll = await db.query('select firm_id from engagement_plans');
    check(
      'sees only own firm applied plans',
      appliedAll.rows.length === 1 && appliedAll.rows[0].firm_id === ids.firm_a,
      `saw ${appliedAll.rows.length}`,
    );

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
    // Owner maintains their own company's data room (they assemble the binder).
    const ownerDrRead = await db.query('select item_code from engagement_data_room_items');
    check(
      'owner reads only their company data room',
      ownerDrRead.rows.length === 1 && ownerDrRead.rows[0].item_code === 'FIN-STMTS',
      `saw ${ownerDrRead.rows.length}`,
    );
    const ownerDrWrite = await db.query(
      `update engagement_data_room_items set readiness_state = 'gap'
       where engagement_id = $1 and item_code = 'FIN-STMTS' returning id`,
      [engagementA],
    );
    check('owner can update their company data room', ownerDrWrite.rowCount === 1);
    // Engagement log is internal advisory reasoning — owners must not see it.
    const ownerLog = await db.query('select id from engagement_log');
    check('owner sees no engagement log (staff-only)', ownerLog.rows.length === 0, `saw ${ownerLog.rows.length}`);
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
    // Applied Plans are owner-visible (docs/37 Q3): owner reads their engagement's
    // applied plan, never firm B's, and cannot write it.
    const ownerPlans = await db.query('select name from engagement_plans');
    check(
      'owner reads only their engagement applied plans',
      ownerPlans.rows.length === 1 && ownerPlans.rows[0].name === 'Firm A applied plan',
      `saw ${JSON.stringify(ownerPlans.rows)}`,
    );
    let ownerPlanWriteBlocked = false;
    try {
      await db.query('savepoint op');
      const upd = await db.query(
        `update engagement_plans set name = 'owner-edit' where firm_id = $1`,
        [ids.firm_a],
      );
      ownerPlanWriteBlocked = upd.rowCount === 0;
      await db.query('release savepoint op');
    } catch {
      ownerPlanWriteBlocked = true;
      await db.query('rollback to savepoint op');
    }
    check('owner cannot write applied plans (read-only)', ownerPlanWriteBlocked);
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

    // --- Collaborator A: view-only, scoped to a SINGLE engagement ----------
    // The client's CPA, invited to engagementA only. Proves the read-only portal
    // scope is per-engagement (not per-company like the owner) and firm-isolated.
    console.log('collaborator (engagement A, view-only):');
    await asUser(ids.user_c);
    const collabEng = await db.query('select id from engagements');
    check('collaborator sees only their one engagement',
      collabEng.rows.length === 1 && collabEng.rows[0].id === engagementA,
      `saw ${JSON.stringify(collabEng.rows)}`);
    const collabCo = await db.query('select name from companies');
    check('collaborator sees only their engagement company',
      collabCo.rows.length === 1 && collabCo.rows[0].name === 'Alpha Co', `saw ${JSON.stringify(collabCo.rows)}`);
    const collabAssess = await db.query('select status from assessments');
    check('collaborator sees only completed assessments',
      collabAssess.rows.length === 1 && collabAssess.rows[0].status === 'completed',
      `saw ${JSON.stringify(collabAssess.rows)}`);
    let collabWriteBlocked = false;
    try {
      await db.query('savepoint cw');
      await db.query(`update companies set name = 'Hijacked' where id = $1`, [companyA]);
      const after = await db.query('select name from companies where id = $1', [companyA]);
      collabWriteBlocked = after.rows[0]?.name !== 'Hijacked';
      await db.query('release savepoint cw');
    } catch {
      collabWriteBlocked = true;
      await db.query('rollback to savepoint cw');
    }
    check('collaborator cannot write (read-only role)', collabWriteBlocked);
    // Internal advisory reasoning is staff-only — a collaborator never sees it.
    const collabLog = await db.query('select id from engagement_log');
    check('collaborator sees no engagement log (staff-only)', collabLog.rows.length === 0, `saw ${collabLog.rows.length}`);
    // Firm branding renders their portal (profile carries firm_id), but never firm B's.
    const collabBrand = await db.query('select display_name from firm_branding');
    check('collaborator reads only their firm branding',
      collabBrand.rows.length === 1 && collabBrand.rows[0].display_name === 'Firm A Advisory',
      `saw ${JSON.stringify(collabBrand.rows)}`);
    // Cannot enumerate the roster or other collaborators (staff-only table).
    const collabRoster = await db.query('select id from engagement_collaborators');
    check('collaborator cannot read the collaborator roster (staff-only)',
      collabRoster.rows.length === 0, `saw ${collabRoster.rows.length}`);

    // --- Admin A: firm-staff access, same firm scope as an advisor ---------
    // Admins are admitted to the workspace by the frontend; RLS now grants them
    // the same firm-scoped access (20260720000100), additively, without loosening
    // firm isolation. These checks prove both: full access within firm A, none to
    // firm B.
    console.log('admin (firm A):');
    await asUser(ids.user_adm);
    const admCo = await db.query('select name from companies');
    check('admin sees exactly own firm companies',
      admCo.rows.length === 1 && admCo.rows[0].name === 'Alpha Co', `saw ${JSON.stringify(admCo.rows)}`);
    const admAssess = await db.query('select status from assessments');
    check('admin sees own firm assessments (both statuses, like an advisor)',
      admAssess.rows.length === 2, `saw ${admAssess.rows.length}`);
    const admFirmB = await db.query('select id from companies where firm_id = $1', [ids.firm_b]);
    check('admin cannot read firm B companies', admFirmB.rows.length === 0, `saw ${admFirmB.rows.length}`);
    // Staff-only table (engagement_log): admin reads own firm, proving the staff
    // coverage extended, and never firm B.
    const admLog = await db.query('select firm_id from engagement_log');
    check('admin cannot read firm B engagement log',
      admLog.rows.every((r) => r.firm_id !== ids.firm_b),
      `saw ${admLog.rows.filter((r) => r.firm_id === ids.firm_b).length} firm B rows`);
    // Read-only firm-scoped table: admin reads own firm subscription, not firm B's.
    const admSub = await db.query('select firm_id from firm_subscriptions');
    check('admin reads only own firm subscription',
      admSub.rows.length === 1 && admSub.rows[0].firm_id === ids.firm_a, `saw ${admSub.rows.length}`);
    let admOwnWrite = false;
    try {
      await db.query('savepoint aw');
      await db.query(`insert into companies (firm_id, name) values ($1, 'Admin Co')`, [ids.firm_a]);
      admOwnWrite = true;
      await db.query('rollback to savepoint aw'); // keep the single-company invariant for later checks
    } catch {
      await db.query('rollback to savepoint aw');
    }
    check('admin can insert a company into own firm', admOwnWrite);
    let admFirmBWriteBlocked = false;
    try {
      await db.query('savepoint awb');
      await db.query(`insert into companies (firm_id, name) values ($1, 'Sneaky Admin Co')`, [ids.firm_b]);
      await db.query('release savepoint awb');
    } catch {
      admFirmBWriteBlocked = true;
      await db.query('rollback to savepoint awb');
    }
    check('admin cannot insert a company into firm B', admFirmBWriteBlocked);

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
